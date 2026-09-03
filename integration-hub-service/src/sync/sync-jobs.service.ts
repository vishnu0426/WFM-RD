import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { SyncJob, SyncType } from '../integrations/entities/sync-job.entity';
import { SyncJobStatus } from '../integrations/entities/integration-connector.entity';
import { IntegrationHubNatsClientService } from '../webhooks/nats/integration-hub-nats-client.service';
import { WebhookFanoutService } from '../webhooks/webhook-fanout.service';

const SYNC_JOB_COMPLETED_SUBJECT = 'agno.integration_hub.sync_job.completed.v1';
const SYNC_JOB_COMPLETED_EVENT_TYPE = 'sync_job.completed';

export interface SyncJobCompletion {
  status: SyncJobStatus.COMPLETED | SyncJobStatus.FAILED | SyncJobStatus.PARTIAL_FAILURE;
  recordsProcessed: number;
  recordsFailed: number;
  /** Never set for `sync_type: streaming` rows - the schema's own CHECK enforces this (§2.2 rule 5); callers for a streaming job must pass `null`. */
  recordsConflicted?: number | null;
  errorDetails?: Record<string, unknown> | null;
}

/**
 * Shared by the batch runner (Phase 2 base; §2.1's `full`/`incremental`
 * rows) and the streaming relay (Phase 2 base; §2.1/§5c's `streaming` rows,
 * where a row is a connection/session window, not a discrete batch).
 */
@Injectable()
export class SyncJobsService {
  private readonly logger = new Logger(SyncJobsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly natsClient: IntegrationHubNatsClientService,
    private readonly webhookFanout: WebhookFanoutService,
  ) {}

  async enqueue(tenantId: string, connectorId: string, syncType: SyncType): Promise<SyncJob> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(SyncJob, {
        id: randomUUID(),
        tenantId,
        connectorId,
        syncType,
        status: SyncJobStatus.QUEUED,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsConflicted: null,
        errorDetails: null,
        startedAt: new Date(),
        completedAt: null,
      }),
    );
  }

  async markRunning(tenantId: string, jobId: string): Promise<SyncJob> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(SyncJob, { id: jobId, tenantId }, { status: SyncJobStatus.RUNNING });
      return manager.findOneByOrFail(SyncJob, { id: jobId, tenantId });
    });
  }

  /** §5a: called from `withBackoffRetry`'s `onRateLimited` callback, threaded down through each batch adapter - see `BatchSyncRunnerService.runOne`'s own construction of this callback. Doesn't touch `status` (the job stays `RUNNING` throughout its retry loop); best-effort, never allowed to fail the actual sync attempt it's just annotating. */
  async markRateLimited(tenantId: string, jobId: string, until: Date): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.update(SyncJob, { id: jobId, tenantId }, { rateLimitedUntil: until }),
    );
  }

  /**
   * §7 Phase 7: the single convergence point every real `SyncJob`
   * completion (batch full/incremental, streaming start-failure, streaming
   * stop) already funnels through - the natural place to fan out, the same
   * role `CoreOutboxPublisherService.drain` plays for Module 01's own
   * webhook framework (ADR-0046). Publishes to NATS first, then fans out
   * webhook deliveries - both best-effort: a NATS/webhook-fanout failure
   * is caught and logged here, never allowed to fail the `SyncJob`
   * completion write itself, which is the actually-durable record of what
   * happened.
   */
  async complete(tenantId: string, jobId: string, completion: SyncJobCompletion): Promise<SyncJob> {
    const job = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      // `errorDetails`'s jsonb `Record<string, unknown> | null` type doesn't
      // satisfy TypeORM's `update()` partial-entity typing for a nullable
      // jsonb column - a real, observed typing gap (not a runtime issue;
      // the same shape works fine via `save()` elsewhere in this service),
      // disclosed rather than silently widened by loosening the entity's
      // own column type.
      await manager.update(SyncJob, { id: jobId, tenantId }, {
        status: completion.status,
        recordsProcessed: completion.recordsProcessed,
        recordsFailed: completion.recordsFailed,
        recordsConflicted: completion.recordsConflicted ?? null,
        errorDetails: completion.errorDetails ?? null,
        completedAt: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return manager.findOneByOrFail(SyncJob, { id: jobId, tenantId });
    });

    const eventPayload = {
      syncJobId: job.id,
      tenantId: job.tenantId,
      connectorId: job.connectorId,
      syncType: job.syncType,
      status: job.status,
      recordsProcessed: job.recordsProcessed,
      recordsFailed: job.recordsFailed,
      recordsConflicted: job.recordsConflicted,
      errorDetails: job.errorDetails,
    };
    await this.natsClient.publish(SYNC_JOB_COMPLETED_SUBJECT, eventPayload).catch((err: Error) => {
      this.logger.warn(`Failed to publish ${SYNC_JOB_COMPLETED_SUBJECT} for job ${job.id}: ${err.message}`);
    });
    await this.webhookFanout.fanOut(tenantId, SYNC_JOB_COMPLETED_EVENT_TYPE, eventPayload);

    return job;
  }

  /**
   * §2.1's streaming-row semantics: "records_processed = events forwarded
   * in the window." A running relay session increments this continuously
   * over its own lifetime, not once at the end - an atomic `col = col +
   * delta` UPDATE, safe under concurrent increments from a fast event
   * stream (no read-modify-write race).
   */
  async incrementCounts(
    tenantId: string,
    jobId: string,
    delta: { processed?: number; failed?: number },
  ): Promise<void> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (delta.processed) {
        setClauses.push(`records_processed = records_processed + $${params.length + 1}`);
        params.push(delta.processed);
      }
      if (delta.failed) {
        setClauses.push(`records_failed = records_failed + $${params.length + 1}`);
        params.push(delta.failed);
      }
      if (setClauses.length === 0) return;
      params.push(jobId, tenantId);
      await manager.query(
        `UPDATE integration_hub.sync_job SET ${setClauses.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
        params,
      );
    });
  }

  async findLatestForConnector(tenantId: string, connectorId: string, syncType?: SyncType): Promise<SyncJob | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(SyncJob).findOne({
        where: syncType ? { tenantId, connectorId, syncType } : { tenantId, connectorId },
        order: { startedAt: 'DESC' },
      }),
    );
  }

  /** §3.1's `syncJobHistory(connectorId, limit)`. */
  async findHistoryForConnector(tenantId: string, connectorId: string, limit: number): Promise<SyncJob[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(SyncJob).find({
        where: { tenantId, connectorId },
        order: { startedAt: 'DESC' },
        take: limit,
      }),
    );
  }
}
