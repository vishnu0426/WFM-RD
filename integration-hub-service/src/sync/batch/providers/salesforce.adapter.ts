import { Injectable } from '@nestjs/common';
import { VaultClientService } from '../../../vault/vault-client.service';
import { FieldMappingsService } from '../../../connectors/field-mappings.service';
import { FieldAuthorityPoliciesService } from '../../../connectors/field-authority-policies.service';
import { ProviderRateLimitConfigService } from '../../provider-rate-limit-config.service';
import { MetricsService } from '../../../common/metrics/metrics.service';
import { BatchConnectorAdapter, BatchSyncOutcome } from '../batch-connector-adapter';
import { IntegrationConnector, SyncJobStatus } from '../../../integrations/entities/integration-connector.entity';
import { SyncJob } from '../../../integrations/entities/sync-job.entity';
import { applyFieldMappings } from './field-mapping-transform';
import { BulkImportClientService, BulkImportRecord } from './bulk-import-client.service';
import { SalesforceApiError } from './salesforce-api-client.errors';
import { withBackoffRetry } from './rate-limit-backoff';
import { RateLimitExhaustedError } from '../../errors/rate-limit-exhausted.error';
import { detectFieldAuthorityConflicts } from '../conflict-detection';

const REQUIRED_BULK_IMPORT_FIELDS = [
  'employeeNumber',
  'orgUnitId',
  'employmentType',
  'contractHoursPerWeek',
  'hireDate',
] as const;

function isCompleteBulkImportRecord(
  record: Record<string, unknown>,
): record is Record<string, unknown> & BulkImportRecord {
  return REQUIRED_BULK_IMPORT_FIELDS.every((field) => record[field] !== undefined && record[field] !== null);
}

interface SoqlQueryResponse {
  totalSize: number;
  done: boolean;
  records?: Record<string, unknown>[];
  nextRecordsUrl?: string;
}

/**
 * §7 Phase 6b's fourth batch adapter, same dry-run/commit/field-authority
 * pipeline as the other three - only `fetchRecords` (auth, endpoint,
 * pagination, rate-limit interpretation) is Salesforce-specific.
 *
 * Two real Salesforce-specific shapes: the query itself is
 * `connector.config.salesforceQuery`, a tenant-supplied SOQL string
 * (unlike Workday/SAP/ADP's fixed endpoint, no single object/field set is
 * correct across every org's schema - this is real, necessary
 * per-connector configuration, not an omission); and the rate-limit
 * breach signal is `type: "header_driven"` (ADR-0135's own seeded row) -
 * a `403`/`REQUEST_LIMIT_EXCEEDED` response, not a `429`, the one
 * researched provider that doesn't use the generic status code every
 * other adapter in this module checks.
 *
 * Real REST query pagination (`nextRecordsUrl`) is followed within a
 * single `withBackoffRetry` attempt - a rate-limit breach mid-pagination
 * retries the whole query from the start on the next attempt rather than
 * resuming from the failed page, the same simplicity `WorkdayAdapter`'s
 * one-call `fetchWorkers` already has, just extended across multiple HTTP
 * calls per attempt instead of one.
 */
@Injectable()
export class SalesforceAdapter implements BatchConnectorAdapter {
  readonly provider = 'Salesforce';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly fieldAuthorityPolicies: FieldAuthorityPoliciesService,
    private readonly bulkImport: BulkImportClientService,
    private readonly providerRateLimitConfig: ProviderRateLimitConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async sync(
    connector: IntegrationConnector,
    _job: SyncJob,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<BatchSyncOutcome> {
    const config = connector.config as Record<string, unknown>;
    const apiBaseUrl = config.salesforceApiBaseUrl as string | undefined;
    const apiVersion = (config.salesforceApiVersion as string | undefined) ?? 'v59.0';
    const query = config.salesforceQuery as string | undefined;
    if (!apiBaseUrl || !query) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: {
          reason: 'missing_config',
          message: 'connector.config.salesforceApiBaseUrl and connector.config.salesforceQuery are both required',
        },
      };
    }

    const credential = await this.vault.read(config.credentialReference as string);
    const bearerToken = credential.accessToken as string | undefined;
    if (!bearerToken) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_credential', message: 'Vault secret has no accessToken field' },
      };
    }

    let rawRecords: Record<string, unknown>[];
    try {
      rawRecords = await this.fetchRecords(apiBaseUrl, apiVersion, query, bearerToken, onRateLimited);
    } catch (err) {
      if (err instanceof RateLimitExhaustedError) {
        this.metrics.recordRateLimitThrottle(this.provider, 'reactive_exhausted');
        return {
          status: SyncJobStatus.PARTIAL_FAILURE,
          recordsProcessed: 0,
          recordsFailed: 0,
          errorDetails: { reason: 'rate_limited_reactive_exhausted', message: err.message },
        };
      }
      throw err;
    }

    const mappings = await this.fieldMappings.findAllForConnector(connector.tenantId, connector.id);
    const transformed = rawRecords.map((record) => applyFieldMappings(record, mappings));
    const validRecords = transformed.filter(isCompleteBulkImportRecord);
    const incompleteCount = transformed.length - validRecords.length;

    if (validRecords.length === 0) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: transformed.length,
        errorDetails: {
          reason: 'no_valid_records',
          totalFetched: rawRecords.length,
          incompleteAfterMapping: incompleteCount,
        },
      };
    }

    const dryRun = await this.bulkImport.submitAndAwait(connector.tenantId, true, validRecords);
    if (dryRun.status === 'failed') {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: validRecords.length + incompleteCount,
        errorDetails: { reason: 'dry_run_failed', message: dryRun.error },
      };
    }
    const moduleConflicts = dryRun.result?.conflicts ?? [];

    const policies = await this.fieldAuthorityPolicies.findAllForConnector(connector.tenantId, connector.id);
    const {
      conflicts: fieldConflicts,
      recordsToReject,
      fieldRevertsByEmployee,
    } = detectFieldAuthorityConflicts(dryRun, policies);

    const recordsToCommit = validRecords
      .filter((record) => !recordsToReject.has(record.employeeNumber))
      .map((record) => {
        const reverts = fieldRevertsByEmployee.get(record.employeeNumber);
        return reverts ? { ...record, ...reverts } : record;
      });

    const conflictedEmployeeNumbers = new Set([
      ...moduleConflicts.map((c) => c.employeeNumber),
      ...fieldConflicts.map((c) => c.employeeNumber),
    ]);

    if (recordsToCommit.length === 0) {
      return {
        status: SyncJobStatus.PARTIAL_FAILURE,
        recordsProcessed: 0,
        recordsFailed: validRecords.length + incompleteCount,
        recordsConflicted: conflictedEmployeeNumbers.size,
        errorDetails: {
          reason: 'all_records_rejected_by_field_authority_policy',
          fieldAuthorityConflicts: fieldConflicts,
          moduleConflicts,
          incompleteAfterMapping: incompleteCount,
        },
      };
    }

    const commit = await this.bulkImport.submitAndAwait(connector.tenantId, false, recordsToCommit);
    if (commit.status === 'failed') {
      return {
        status: SyncJobStatus.PARTIAL_FAILURE,
        recordsProcessed: 0,
        recordsFailed: validRecords.length + incompleteCount,
        recordsConflicted: conflictedEmployeeNumbers.size,
        errorDetails: {
          reason: 'commit_failed',
          message: commit.error,
          fieldAuthorityConflicts: fieldConflicts,
          moduleConflicts,
          incompleteAfterMapping: incompleteCount,
        },
      };
    }

    const committed = commit.result?.committed ?? { created: 0, updated: 0 };
    const hasAnyIssue = conflictedEmployeeNumbers.size > 0 || incompleteCount > 0 || recordsToReject.size > 0;
    return {
      status: hasAnyIssue ? SyncJobStatus.PARTIAL_FAILURE : SyncJobStatus.COMPLETED,
      recordsProcessed: committed.created + committed.updated,
      recordsFailed: recordsToReject.size + incompleteCount,
      recordsConflicted: conflictedEmployeeNumbers.size,
      errorDetails: hasAnyIssue
        ? {
            reason: 'partial',
            fieldAuthorityConflicts: fieldConflicts,
            moduleConflicts,
            recordsRejectedByPolicy: [...recordsToReject],
            incompleteAfterMapping: incompleteCount,
          }
        : null,
    };
  }

  private async fetchRecords(
    apiBaseUrl: string,
    apiVersion: string,
    query: string,
    bearerToken: string,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const rateLimitConfig = await this.providerRateLimitConfig.findByProvider(this.provider);
    const backoffStrategy = rateLimitConfig?.backoffStrategy ?? {};
    const onBreachStatus = backoffStrategy.on_breach_status ?? 403;
    const onBreachCode = backoffStrategy.on_breach_code ?? 'REQUEST_LIMIT_EXCEEDED';

    return withBackoffRetry<Record<string, unknown>[]>(
      this.provider,
      backoffStrategy,
      async (_attemptNumber) => {
        const records: Record<string, unknown>[] = [];
        let path: string | null = `/services/data/${apiVersion}/query?q=${encodeURIComponent(query)}`;

        while (path) {
          let response: Response;
          try {
            response = await fetch(`${apiBaseUrl}${path}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
            });
          } catch (err) {
            throw new SalesforceApiError((err as Error).message);
          }

          if (response.status === onBreachStatus) {
            const body = (await response.json().catch(() => null)) as
              Array<{ errorCode?: string }> | { errorCode?: string } | null;
            const errorCode = Array.isArray(body) ? body[0]?.errorCode : body?.errorCode;
            if (errorCode === onBreachCode) {
              this.metrics.recordRateLimitThrottle(this.provider, 'reactive_retry');
              return { rateLimited: true };
            }
            throw new SalesforceApiError(`HTTP ${response.status}: unexpected errorCode "${errorCode}"`);
          }
          if (!response.ok) {
            throw new SalesforceApiError(`HTTP ${response.status}`);
          }
          const body = (await response.json()) as SoqlQueryResponse;
          records.push(...(body.records ?? []));
          path = body.done ? null : (body.nextRecordsUrl ?? null);
        }

        return { result: records };
      },
      undefined,
      onRateLimited,
    );
  }
}
