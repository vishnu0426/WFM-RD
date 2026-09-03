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
import { WorkdayApiError } from './workday-api-client.errors';
import { withBackoffRetry } from './rate-limit-backoff';
import { RateLimitExhaustedError } from '../../errors/rate-limit-exhausted.error';
import { detectFieldAuthorityConflicts } from '../conflict-detection';

/** GAP-13 fix (enterprise readiness audit, 2026-08-18): Workday's own documented default/max page size for worker collection endpoints. */
const PAGE_SIZE = 100;

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
 * §7 Phase 3's first real batch adapter, extended in Phase 4 with §5b's
 * field authority conflict detection and in Phase 5 with §5a's reactive
 * rate-limit backoff (the proactive half lives one layer up, in
 * `BatchSyncRunnerService` - this adapter is only ever invoked once that
 * check has already passed). Real HTTP against a configurable
 * Workday-shaped REST endpoint (`config.workdayApiBaseUrl`) - this
 * environment has no real, credentialed Workday tenant to call, so
 * verification runs against a real local HTTP server standing in for
 * Workday's actual API shape - see the Phase 3/4/5 design docs.
 *
 * §5a's reactive half: if Workday's own API still returns a rate-limit
 * response despite the proactive throttle having already passed (a real,
 * expected possibility - the proactive bucket is this module's own
 * estimate, not a live subscription to the provider's actual quota state),
 * `fetchWorkers` retries using Workday's own seeded `backoff_strategy`
 * (`ProviderRateLimitConfig`, real exponential shape:
 * `base_ms`/`max_retries`/`respect_retry_after`). Exhausting retries
 * produces a distinct `rate_limited_reactive_exhausted` `partial_failure`
 * outcome - never lumped into the generic `adapter_threw` bucket, and
 * never silently reported as `completed` (§5a).
 */
@Injectable()
export class WorkdayAdapter implements BatchConnectorAdapter {
  readonly provider = 'Workday';

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
    const apiBaseUrl = config.workdayApiBaseUrl as string | undefined;
    if (!apiBaseUrl) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_config', message: 'connector.config.workdayApiBaseUrl is not set' },
      };
    }

    const credential = await this.vault.read(config.credentialReference as string);
    const bearerToken = (credential.accessToken ?? credential.apiToken) as string | undefined;
    if (!bearerToken) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_credential', message: 'Vault secret has no accessToken/apiToken field' },
      };
    }

    let rawWorkers: Record<string, unknown>[];
    try {
      rawWorkers = await this.fetchWorkers(apiBaseUrl, bearerToken, onRateLimited);
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

    const transformed = rawWorkers.map((worker) => applyFieldMappings(worker, mappings));
    const validRecords = transformed.filter(isCompleteBulkImportRecord);
    const incompleteCount = transformed.length - validRecords.length;

    if (validRecords.length === 0) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: transformed.length,
        errorDetails: {
          reason: 'no_valid_records',
          totalFetched: rawWorkers.length,
          incompleteAfterMapping: incompleteCount,
        },
      };
    }

    // §2.2 rule 3a: dry-run always precedes a live commit.
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

    // §5b: field authority conflict detection against the dry-run's own diff.
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
      // The dry run genuinely succeeded; only the commit half failed (most
      // commonly Module 02's own `bulk_import_destructive` flag not being
      // enabled for this tenant yet) - partial_failure, not failed, and
      // every conflict class is preserved.
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

  /**
   * GAP-13 fix (enterprise readiness audit, 2026-08-18): this used to issue
   * exactly one GET with no `limit`/`offset` at all - any tenant with more
   * workers than fit in Workday's own default single-page response size
   * silently got a partial dataset, with no error, no `partial_failure`
   * flag, nothing. Workday's real REST API paginates via `limit`/`offset`
   * query params and echoes `total` in the response body (the same shape
   * Salesforce's own adapter already handles correctly via `nextRecordsUrl`
   * - see `salesforce.adapter.ts`) - this now loops pages until `offset +
   * data.length >= total` (or an empty page, as a defensive stop condition
   * if `total` is ever missing/wrong), accumulating every worker before
   * returning, so `sync()` above sees the complete roster, not page 1.
   */
  private async fetchWorkers(
    apiBaseUrl: string,
    bearerToken: string,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const rateLimitConfig = await this.providerRateLimitConfig.findByProvider(this.provider);
    const backoffStrategy = rateLimitConfig?.backoffStrategy ?? {};

    const workers: Record<string, unknown>[] = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await withBackoffRetry<{ data: Record<string, unknown>[]; total: number | null }>(
        this.provider,
        backoffStrategy,
        async (_attemptNumber) => {
          let response: Response;
          try {
            response = await fetch(`${apiBaseUrl}/workers?limit=${PAGE_SIZE}&offset=${offset}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
            });
          } catch (err) {
            throw new WorkdayApiError((err as Error).message);
          }

          if (response.status === 429) {
            // Every real 429 encountered is a delay worth surfacing
            // distinctly (§5a) - including the first one, not just
            // retries-of-retries.
            this.metrics.recordRateLimitThrottle(this.provider, 'reactive_retry');
            const retryAfterHeader = response.headers.get('retry-after');
            return {
              rateLimited: true,
              retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
            };
          }
          if (!response.ok) {
            throw new WorkdayApiError(`HTTP ${response.status}`);
          }
          const body = (await response.json()) as { data?: unknown; total?: unknown };
          if (!Array.isArray(body.data)) {
            throw new WorkdayApiError('response body has no "data" array');
          }
          return {
            result: {
              data: body.data as Record<string, unknown>[],
              total: typeof body.total === 'number' ? body.total : null,
            },
          };
        },
        undefined,
        onRateLimited,
      );

      workers.push(...page.data);
      offset += page.data.length;

      // Stop once every page has been fetched (offset covers `total`), or
      // defensively on an empty/undersized page - a response with no
      // `total` field but fewer rows than `PAGE_SIZE` is the last page;
      // one with no `total` and a full page has no way to know it's done
      // other than fetching the (now-empty) next page.
      const coveredTotal = page.total !== null && offset >= page.total;
      const shortPage = page.data.length < PAGE_SIZE;
      if (coveredTotal || (page.total === null && shortPage) || page.data.length === 0) {
        break;
      }
    }
    return workers;
  }
}
