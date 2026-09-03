import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MetricsService } from '../../common/metrics/metrics.service';
import { SyncJobsService } from '../sync-jobs.service';
import { BatchAdapterRegistry } from './batch-adapter-registry.service';
import { RateLimiterService } from './rate-limiter.service';
import { NoBatchAdapterRegisteredError } from '../errors/no-batch-adapter-registered.error';
import { SyncNotSupportedForConnectorTypeError } from '../errors/sync-not-supported-for-connector-type.error';
import { isBatchConnectorType } from '../../integrations/connector-type.utils';
import { ConnectorNotFoundError } from '../../connectors/errors/connector-not-found.error';
import { ConnectorStatus, SyncJobStatus } from '../../integrations/entities/integration-connector.entity';
import { SyncJob, SyncType } from '../../integrations/entities/sync-job.entity';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { IntegrationConnector } from '../../integrations/entities/integration-connector.entity';

/**
 * §5a/§7 Phase 2's "batch-runner base", extended in Phase 5 with the
 * proactive rate-limit throttle: "the sync job runner enforces this
 * *before* making calls, not reactively after a 429." A connector whose
 * `provider` has no registered adapter fails its `SyncJob` cleanly with a
 * clear `NO_BATCH_ADAPTER_REGISTERED` reason; a connector throttled by its
 * own provider's token bucket fails just as cleanly with a distinct
 * `rate_limited` reason (§5a: "surface rate-limit-driven delays distinctly
 * from actual failures") - neither is a bug to work around by faking a
 * successful sync.
 *
 * Every tick is a single global interval across every active batch
 * connector, not yet a per-connector custom schedule read from
 * `IntegrationConnector.config` - §2.1 mentions "sync schedule" as
 * something `config` *can* hold, but no shape for it was ever decided, and
 * this phase's own scope doesn't require deciding it now.
 *
 * `adapter.sync()` receives the connector's real, full `config` - a real
 * Phase 2 bug, fixed in Phase 3, see that file's own history if this
 * comment is ever confusing in isolation.
 */
@Injectable()
export class BatchSyncRunnerService {
  private readonly logger = new Logger(BatchSyncRunnerService.name);

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly migratorPool: Pool,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly syncJobs: SyncJobsService,
    private readonly registry: BatchAdapterRegistry,
    private readonly rateLimiter: RateLimiterService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(process.env.BATCH_SYNC_CRON_EXPRESSION ?? '*/15 * * * *')
  async tick(): Promise<void> {
    const due = await this.findDueConnectors();
    for (const connector of due) {
      try {
        await this.runOne(connector, SyncType.INCREMENTAL);
      } catch (err) {
        // A single connector's failure (including "no adapter
        // registered"/"rate limited," both already handled inside runOne
        // as a completed-with-failure SyncJob) must never abort the tick
        // for every other connector - only a genuinely unexpected throw
        // reaches here.
        this.logger.error(`Unhandled error syncing connector ${connector.id}: ${(err as Error).message}`);
      }
    }
  }

  /** §3.2's `POST /v1/integrations/connectors/{id}/sync`. */
  async triggerManualSync(tenantId: string, connectorId: string): Promise<SyncJob> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: connectorId } }),
    );
    if (!connector) {
      throw new ConnectorNotFoundError(connectorId);
    }
    if (!isBatchConnectorType(connector.connectorType)) {
      throw new SyncNotSupportedForConnectorTypeError(connector.connectorType);
    }
    return this.runOne(connector, SyncType.INCREMENTAL);
  }

  private async findDueConnectors(): Promise<IntegrationConnector[]> {
    // Cross-tenant read via the migrator pool (own doc comment) - excludes
    // any connector that already has a running job, so a slow real
    // adapter (Phase 3+) never gets a second overlapping tick. Selects
    // every column `adapter.sync()` might need, not a hand-picked subset.
    const { rows } = await this.migratorPool.query<IntegrationConnector>(
      `SELECT c.id, c.tenant_id AS "tenantId", c.provider, c.connector_type AS "connectorType",
              c.status, c.config, c.last_sync_at AS "lastSyncAt", c.last_sync_status AS "lastSyncStatus"
       FROM integration_hub.integration_connector c
       WHERE c.connector_type IN ('hris', 'payroll', 'crm')
         AND c.status = $1
         AND NOT EXISTS (
           SELECT 1 FROM integration_hub.sync_job j
           WHERE j.connector_id = c.id AND j.status = $2
         )`,
      [ConnectorStatus.ACTIVE, SyncJobStatus.RUNNING],
    );
    return rows;
  }

  private async runOne(connector: IntegrationConnector, syncType: SyncType): Promise<SyncJob> {
    const start = process.hrtime.bigint();
    const job = await this.syncJobs.enqueue(connector.tenantId, connector.id, syncType);

    // §5a: enforced *before* making any call to the provider, not
    // reactively after a 429 - a throttled connector never reaches
    // `markRunning`/`adapter.sync()` at all this tick.
    const rateLimitDecision = await this.rateLimiter.tryAcquire(connector.tenantId, connector.id, connector.provider);
    if (!rateLimitDecision.allowed) {
      const completed = await this.syncJobs.complete(connector.tenantId, job.id, {
        status: SyncJobStatus.PARTIAL_FAILURE,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: {
          reason: 'rate_limited',
          provider: connector.provider,
          retryAfterMs: rateLimitDecision.retryAfterMs,
        },
      });
      this.metrics.recordRateLimitThrottle(connector.provider, 'proactive');
      this.recordDuration(connector.provider, syncType, SyncJobStatus.PARTIAL_FAILURE, start);
      return completed;
    }

    const running = await this.syncJobs.markRunning(connector.tenantId, job.id);

    const adapter = this.registry.find(connector.provider);
    if (!adapter) {
      // Surfaced via the returned SyncJob's own status/errorDetails, never
      // a fabricated success (§5a: never silently truncate/report
      // completed) - `NoBatchAdapterRegisteredError` exists as a typed
      // error class for callers that want to distinguish this case
      // explicitly, but the runner itself completes the job rather than
      // throwing, so one connector with no adapter can't abort a `tick()`
      // that's also processing other, adapter-backed connectors.
      const completed = await this.syncJobs.complete(connector.tenantId, running.id, {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: {
          reason: 'no_adapter_registered',
          provider: connector.provider,
          code: new NoBatchAdapterRegisteredError(connector.provider).code,
        },
      });
      this.recordDuration(connector.provider, syncType, SyncJobStatus.FAILED, start);
      return completed;
    }

    try {
      const outcome = await adapter.sync(connector, running, (delayMs) =>
        this.syncJobs.markRateLimited(connector.tenantId, running.id, new Date(Date.now() + delayMs)),
      );
      const completed = await this.syncJobs.complete(connector.tenantId, running.id, outcome);
      this.recordDuration(connector.provider, syncType, outcome.status, start);
      return completed;
    } catch (err) {
      const completed = await this.syncJobs.complete(connector.tenantId, running.id, {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'adapter_threw', message: (err as Error).message },
      });
      this.recordDuration(connector.provider, syncType, SyncJobStatus.FAILED, start);
      return completed;
    }
  }

  private recordDuration(provider: string, syncType: SyncType, status: SyncJobStatus, start: bigint): void {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    this.metrics.observeSyncJobDuration(provider, syncType, status, seconds);
  }
}
