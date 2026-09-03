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
import { SapSuccessFactorsApiError } from './sap-successfactors-api-client.errors';
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

/**
 * §7 Phase 6b's second batch adapter. Same dry-run/commit/field-authority
 * pipeline `WorkdayAdapter` (Phase 3/4/5) already proved end to end -
 * everything below `fetchWorkers` is deliberately identical in shape, not
 * reinvented per provider.
 *
 * §1's non-OAuth credential path is used here even though SAP's real auth
 * is OAuth2-via-SAML-Bearer-Assertion (`docs/module-12-provider-research.md`
 * - Basic Auth is deprecated with a November 2026 sunset, already imminent
 * as of this build): this adapter consumes a pre-obtained bearer token
 * from Vault (`credential.accessToken`), the same "tenant obtains the token
 * out-of-band, this module stores and uses it" posture `WorkdayAdapter`
 * already established for Workday's own OAuth. Implementing SAP's SAML
 * Bearer Assertion exchange itself (signing and posting a SAML assertion
 * to SAP's token endpoint) is real, separate, provider-specific auth-flow
 * work this phase doesn't build.
 *
 * SAP's real OData v2 JSON response envelope is `{d: {results: [...]}}`
 * (not a bare array, unlike Workday's fixture) - this adapter unwraps it
 * exactly that way, and this environment has no real, credentialed
 * SuccessFactors tenant, so verification runs against a real local server
 * that speaks this exact envelope shape - see the Phase 6b design doc.
 */
@Injectable()
export class SapSuccessFactorsAdapter implements BatchConnectorAdapter {
  readonly provider = 'SAP SuccessFactors';

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
    const apiBaseUrl = config.sapApiBaseUrl as string | undefined;
    if (!apiBaseUrl) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_config', message: 'connector.config.sapApiBaseUrl is not set' },
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

    let rawPersons: Record<string, unknown>[];
    try {
      rawPersons = await this.fetchPersons(apiBaseUrl, bearerToken, onRateLimited);
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
    const transformed = rawPersons.map((person) => applyFieldMappings(person, mappings));
    const validRecords = transformed.filter(isCompleteBulkImportRecord);
    const incompleteCount = transformed.length - validRecords.length;

    if (validRecords.length === 0) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: transformed.length,
        errorDetails: {
          reason: 'no_valid_records',
          totalFetched: rawPersons.length,
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

  private async fetchPersons(
    apiBaseUrl: string,
    bearerToken: string,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const rateLimitConfig = await this.providerRateLimitConfig.findByProvider(this.provider);
    const backoffStrategy = rateLimitConfig?.backoffStrategy ?? {};

    return withBackoffRetry<Record<string, unknown>[]>(
      this.provider,
      backoffStrategy,
      async (_attemptNumber) => {
        let response: Response;
        try {
          response = await fetch(`${apiBaseUrl}/odata/v2/PerPerson?$format=json`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
          });
        } catch (err) {
          throw new SapSuccessFactorsApiError((err as Error).message);
        }

        if (response.status === 429) {
          this.metrics.recordRateLimitThrottle(this.provider, 'reactive_retry');
          const retryAfterHeader = response.headers.get('retry-after');
          return {
            rateLimited: true,
            retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
          };
        }
        if (!response.ok) {
          throw new SapSuccessFactorsApiError(`HTTP ${response.status}`);
        }
        const body = (await response.json()) as { d?: { results?: unknown } };
        if (!Array.isArray(body.d?.results)) {
          throw new SapSuccessFactorsApiError('response body has no "d.results" array (real OData v2 envelope shape)');
        }
        return { result: body.d.results as Record<string, unknown>[] };
      },
      undefined,
      onRateLimited,
    );
  }
}
