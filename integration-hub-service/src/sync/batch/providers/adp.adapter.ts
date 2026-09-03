import { Injectable } from '@nestjs/common';
import { Agent } from 'undici';
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
import { AdpApiError } from './adp-api-client.errors';
import { withBackoffRetry } from './rate-limit-backoff';
import { RateLimitExhaustedError } from '../../errors/rate-limit-exhausted.error';
import { detectFieldAuthorityConflicts } from '../conflict-detection';

/** GAP-13 fix (enterprise readiness audit, 2026-08-18): ADP HR v2 API's documented `$top` page-size cap for worker collection endpoints. */
const PAGE_SIZE = 100;

/**
 * GAP-12 fix: Node's global `fetch` accepts a `dispatcher` option at
 * runtime (undici's per-request override of which connection pool/TLS
 * config handles the call - this is the actual mTLS wiring), but the
 * standard `RequestInit` type from `lib.dom.d.ts` doesn't declare it since
 * it's a Node/undici extension, not part of the Fetch spec. A narrow,
 * explicit extension here is more honest than an untyped `as any` on the
 * whole call.
 */
type FetchInitWithDispatcher = RequestInit & { dispatcher?: Agent };

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
 * §7 Phase 6b's third batch adapter, same dry-run/commit/field-authority
 * pipeline as `WorkdayAdapter`/`SapSuccessFactorsAdapter`.
 *
 * ADP's real auth is OAuth2 Client Credentials *plus a mandatory mutual-TLS
 * client certificate* (`docs/module-12-provider-research.md` - a 2-year
 * cert from ADP's Partner Self-Service Portal is a hard prerequisite for
 * every call, a materially different credential shape from every other
 * batch provider this module supports). This adapter's credential shape
 * (`credential.accessToken`, `credential.clientCertPem`,
 * `credential.clientKeyPem`) reflects that real shape - Vault stores all
 * three.
 *
 * GAP-12 fix (enterprise readiness audit, 2026-08-18): the mTLS handshake
 * is now actually wired into the HTTP calls, not just stored. Node's
 * global `fetch` has no per-request client-certificate option, but it does
 * accept a non-standard `dispatcher` option - `fetchWorkers` builds a
 * per-sync `undici.Agent` with `connect: { cert, key }` from the Vault
 * material and passes it as that `dispatcher`, then closes it once the
 * sync completes (success or failure) so a long-running dispatcher process
 * making many syncs over time doesn't leak a TLS connection pool per
 * call. If `clientCertPem`/`clientKeyPem` are missing from Vault, the sync
 * still fails explicitly (`missing_mtls_material`) rather than silently
 * sending a bearer-token-only request ADP's real API would reject - that
 * guard is unchanged, only the "material is present" path is new.
 */
@Injectable()
export class AdpAdapter implements BatchConnectorAdapter {
  readonly provider = 'ADP';

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
    const apiBaseUrl = config.adpApiBaseUrl as string | undefined;
    if (!apiBaseUrl) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_config', message: 'connector.config.adpApiBaseUrl is not set' },
      };
    }

    const credential = await this.vault.read(config.credentialReference as string);
    const bearerToken = credential.accessToken as string | undefined;
    const clientCertPem = credential.clientCertPem as string | undefined;
    const clientKeyPem = credential.clientKeyPem as string | undefined;
    if (!bearerToken) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'missing_credential', message: 'Vault secret has no accessToken field' },
      };
    }
    if (!clientCertPem || !clientKeyPem) {
      return {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: {
          reason: 'missing_mtls_material',
          message:
            'ADP requires a mutual-TLS client certificate for every call; Vault secret is missing clientCertPem/clientKeyPem.',
        },
      };
    }

    // GAP-12 fix: a per-sync mTLS dispatcher, closed in `finally` regardless
    // of outcome - see this class's own doc comment.
    const mtlsAgent = new Agent({ connect: { cert: clientCertPem, key: clientKeyPem } });
    let rawWorkers: Record<string, unknown>[];
    try {
      try {
        rawWorkers = await this.fetchWorkers(apiBaseUrl, bearerToken, mtlsAgent, onRateLimited);
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
    } finally {
      await mtlsAgent.close();
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

  /**
   * GAP-13 fix (enterprise readiness audit, 2026-08-18): this used to issue
   * exactly one GET with `$top=100` and no `$skip` at all - any tenant with
   * more than 100 workers silently got a partial dataset. ADP's real HR v2
   * API paginates via OData `$top`/`$skip` (`docs/module-12-provider-research.md`:
   * "batch sync uses the same rate/concurrency-gated REST endpoints with
   * $top/$skip pagination") - this now loops pages via `$skip`, stopping
   * once a page returns fewer than `$top` workers (or zero), the standard
   * OData end-of-collection signal that doesn't require guessing at an
   * unconfirmed total-count envelope field.
   */
  private async fetchWorkers(
    apiBaseUrl: string,
    bearerToken: string,
    mtlsAgent: Agent,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const rateLimitConfig = await this.providerRateLimitConfig.findByProvider(this.provider);
    const backoffStrategy = rateLimitConfig?.backoffStrategy ?? {};

    const workers: Record<string, unknown>[] = [];
    let skip = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await withBackoffRetry<Record<string, unknown>[]>(
        this.provider,
        backoffStrategy,
        async (_attemptNumber) => {
          let response: Response;
          try {
            // GAP-12 fix: `dispatcher` is undici's (non-standard, but
            // Node's global `fetch` supports it) per-request override for
            // which connection pool/TLS config handles this call - this is
            // the actual mTLS handshake, not just carrying the cert
            // material around unused.
            response = await fetch(`${apiBaseUrl}/hr/v2/workers?$top=${PAGE_SIZE}&$skip=${skip}`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
              dispatcher: mtlsAgent,
            } as FetchInitWithDispatcher);
          } catch (err) {
            throw new AdpApiError((err as Error).message);
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
            throw new AdpApiError(`HTTP ${response.status}`);
          }
          const body = (await response.json()) as { workers?: unknown };
          if (!Array.isArray(body.workers)) {
            throw new AdpApiError('response body has no "workers" array (real ADP HR API v2 envelope shape)');
          }
          return { result: body.workers as Record<string, unknown>[] };
        },
        undefined,
        onRateLimited,
      );

      workers.push(...page);
      skip += page.length;
      if (page.length < PAGE_SIZE) {
        break;
      }
    }
    return workers;
  }
}
