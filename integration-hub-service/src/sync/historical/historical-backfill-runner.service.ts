import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { IntegrationConnector, SyncJobStatus } from '../../integrations/entities/integration-connector.entity';
import { SyncJob, SyncType } from '../../integrations/entities/sync-job.entity';
import { HistoricalBackfillChunk, HistoricalBackfillChunkStatus } from '../../integrations/entities/historical-backfill-chunk.entity';
import { HistoricalRecord } from '../../integrations/entities/historical-record.entity';
import { HistoricalAdapterRegistry } from './historical-adapter-registry.service';
import { ConnectorNotFoundError } from '../../connectors/errors/connector-not-found.error';
import { HistoricalImportNotSupportedError } from './errors/historical-import-not-supported.error';
import { InvalidHistoricalImportRangeError } from './errors/invalid-historical-import-range.error';
import { HistoricalImportNotFoundError } from './errors/historical-import-not-found.error';
import { AuditGrpcClientService } from '../../grpc/audit-grpc-client.service';
import { Actor } from '../../connectors/integration-connectors.service';

const CHUNK_SIZE_DAYS = 7;
const DEFAULT_ACTOR: Actor = { id: null, type: 'system' };

interface DueChunk {
  tenantId: string;
  jobId: string;
  chunkId: string;
}

/**
 * Tenant Admin Integration Management, WP5 (plan decision #6). Same
 * "cross-tenant cron via the migrator pool, real work through
 * `withTenantConnection`" shape as `BatchSyncRunnerService`. Processes at
 * most one chunk per due job per tick - never the whole range inline in an
 * HTTP request, so an arbitrarily large backfill never blocks a caller.
 *
 * A connector whose provider has no registered `HistoricalConnectorAdapter`
 * fails the job cleanly with `HISTORICAL_IMPORT_NOT_SUPPORTED` - see that
 * error's own doc comment for why this is the correct, honest behavior
 * today for every provider in this codebase.
 */
@Injectable()
export class HistoricalBackfillRunnerService {
  private readonly logger = new Logger(HistoricalBackfillRunnerService.name);

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly migratorPool: Pool,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: HistoricalAdapterRegistry,
    private readonly audit: AuditGrpcClientService,
  ) {}

  async start(
    tenantId: string,
    connectorId: string,
    datasetKey: string,
    rangeStart: string,
    rangeEnd: string,
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<SyncJob> {
    if (rangeEnd < rangeStart) {
      throw new InvalidHistoricalImportRangeError(rangeStart, rangeEnd);
    }
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: connectorId } }),
    );
    if (!connector) throw new ConnectorNotFoundError(connectorId);

    const jobId = randomUUID();
    const chunkRanges = buildChunkRanges(rangeStart, rangeEnd, CHUNK_SIZE_DAYS);
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.save(SyncJob, {
        id: jobId,
        tenantId,
        connectorId,
        syncType: SyncType.HISTORICAL,
        status: SyncJobStatus.QUEUED,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsConflicted: null,
        recordsFound: 0,
        recordsDuplicate: 0,
        errorDetails: null,
        datasetKey,
        rangeStart,
        rangeEnd,
        startedAt: new Date(),
        completedAt: null,
      });
      await manager.save(
        HistoricalBackfillChunk,
        chunkRanges.map((range, index) => ({
          id: randomUUID(),
          tenantId,
          syncJobId: jobId,
          chunkIndex: index,
          rangeStart: range.start,
          rangeEnd: range.end,
          status: HistoricalBackfillChunkStatus.QUEUED,
          checkpointCursor: null,
          recordsFound: 0,
          recordsProcessed: 0,
          recordsFailed: 0,
          recordsDuplicate: 0,
          errorDetails: null,
          startedAt: null,
          completedAt: null,
        })),
      );
    });

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'historical_import.started',
      resourceType: 'sync_job',
      resourceId: jobId,
      beforeStateJson: '',
      afterStateJson: JSON.stringify({ connectorId, datasetKey, rangeStart, rangeEnd, chunkCount: chunkRanges.length }),
      aiRationaleJson: '',
    });

    // Fail fast rather than waiting for a cron tick, same as
    // `BatchSyncRunnerService.runOne`'s "no adapter registered" path -
    // real for every current provider (see this service's own doc comment).
    if (!this.registry.find(connector.provider)) {
      await this.failJobUnsupported(tenantId, jobId, connector.provider);
    }

    return this.findJob(tenantId, jobId);
  }

  async findJob(tenantId: string, jobId: string): Promise<SyncJob> {
    const job = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(SyncJob, { where: { tenantId, id: jobId, syncType: SyncType.HISTORICAL } }),
    );
    if (!job) throw new HistoricalImportNotFoundError(jobId);
    return job;
  }

  async listForConnector(tenantId: string, connectorId: string): Promise<SyncJob[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(SyncJob).find({
        where: { tenantId, connectorId, syncType: SyncType.HISTORICAL },
        order: { startedAt: 'DESC' },
      }),
    );
  }

  async chunksForJob(tenantId: string, jobId: string): Promise<HistoricalBackfillChunk[]> {
    await this.findJob(tenantId, jobId);
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(HistoricalBackfillChunk).find({
        where: { tenantId, syncJobId: jobId },
        order: { chunkIndex: 'ASC' },
      }),
    );
  }

  /** The real landed rows (spec §38's "Raw Data" layer) - capped, not the full set, for a UI preview rather than a bulk export. */
  async recordsForJob(tenantId: string, jobId: string, limit = 100): Promise<HistoricalRecord[]> {
    await this.findJob(tenantId, jobId);
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(HistoricalRecord).find({
        where: { tenantId, syncJobId: jobId },
        order: { fetchedAt: 'DESC' },
        take: Math.min(limit, 500),
      }),
    );
  }

  async retryChunk(tenantId: string, chunkId: string, actor: Actor = DEFAULT_ACTOR): Promise<HistoricalBackfillChunk> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const chunk = await manager.findOne(HistoricalBackfillChunk, { where: { tenantId, id: chunkId } });
      if (!chunk) throw new HistoricalImportNotFoundError(chunkId);
      await manager.update(
        HistoricalBackfillChunk,
        { id: chunkId, tenantId },
        { status: HistoricalBackfillChunkStatus.QUEUED, errorDetails: null },
      );
      await manager.update(
        SyncJob,
        { id: chunk.syncJobId, tenantId },
        { status: SyncJobStatus.RUNNING, completedAt: null },
      );
      return manager.findOneByOrFail(HistoricalBackfillChunk, { id: chunkId, tenantId });
    }).then(async (chunk) => {
      await this.audit.record({
        tenantId,
        actorId: actor.id ?? '',
        actorType: actor.type,
        action: 'historical_import.chunk_retried',
        resourceType: 'historical_backfill_chunk',
        resourceId: chunkId,
        beforeStateJson: '',
        afterStateJson: '',
        aiRationaleJson: '',
      });
      return chunk;
    });
  }

  /** Requeues every FAILED chunk under this job (keeping each one's checkpoint cursor) and moves the job back to RUNNING. */
  async resume(tenantId: string, jobId: string, actor: Actor = DEFAULT_ACTOR): Promise<SyncJob> {
    await this.findJob(tenantId, jobId);
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(
        HistoricalBackfillChunk,
        { tenantId, syncJobId: jobId, status: HistoricalBackfillChunkStatus.FAILED },
        { status: HistoricalBackfillChunkStatus.QUEUED, errorDetails: null },
      );
      await manager.update(SyncJob, { id: jobId, tenantId }, { status: SyncJobStatus.RUNNING, completedAt: null });
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'historical_import.resumed',
      resourceType: 'sync_job',
      resourceId: jobId,
      beforeStateJson: '',
      afterStateJson: '',
      aiRationaleJson: '',
    });
    return this.findJob(tenantId, jobId);
  }

  async cancel(tenantId: string, jobId: string, actor: Actor = DEFAULT_ACTOR): Promise<SyncJob> {
    await this.findJob(tenantId, jobId);
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(
        HistoricalBackfillChunk,
        { tenantId, syncJobId: jobId, status: HistoricalBackfillChunkStatus.QUEUED },
        { status: HistoricalBackfillChunkStatus.CANCELLED },
      );
      await manager.update(
        HistoricalBackfillChunk,
        { tenantId, syncJobId: jobId, status: HistoricalBackfillChunkStatus.RUNNING },
        { status: HistoricalBackfillChunkStatus.CANCELLED },
      );
      await manager.update(
        SyncJob,
        { id: jobId, tenantId },
        { status: SyncJobStatus.CANCELLED, completedAt: new Date() },
      );
    });
    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'historical_import.cancelled',
      resourceType: 'sync_job',
      resourceId: jobId,
      beforeStateJson: '',
      afterStateJson: '',
      aiRationaleJson: '',
    });
    return this.findJob(tenantId, jobId);
  }

  @Cron(process.env.HISTORICAL_BACKFILL_CRON_EXPRESSION ?? '*/2 * * * *')
  async tick(): Promise<void> {
    const due = await this.findDueChunks();
    for (const item of due) {
      try {
        await this.processChunk(item.tenantId, item.jobId, item.chunkId);
      } catch (err) {
        this.logger.error(`Unhandled error processing historical backfill chunk ${item.chunkId}: ${(err as Error).message}`);
      }
    }
  }

  private async findDueChunks(): Promise<DueChunk[]> {
    // One queued chunk per due job, per tick - cross-tenant read via the
    // migrator pool, same as `BatchSyncRunnerService.findDueConnectors`.
    const { rows } = await this.migratorPool.query<{ tenant_id: string; sync_job_id: string; chunk_id: string }>(
      `SELECT DISTINCT ON (c.sync_job_id)
         c.tenant_id AS tenant_id, c.sync_job_id AS sync_job_id, c.id AS chunk_id
       FROM integration_hub.historical_backfill_chunk c
       JOIN integration_hub.sync_job j ON j.id = c.sync_job_id
       WHERE j.sync_type = 'historical'
         AND j.status IN ('queued', 'running')
         AND c.status = 'queued'
       ORDER BY c.sync_job_id, c.chunk_index ASC`,
    );
    return rows.map((row) => ({ tenantId: row.tenant_id, jobId: row.sync_job_id, chunkId: row.chunk_id }));
  }

  private async processChunk(tenantId: string, jobId: string, chunkId: string): Promise<void> {
    const job = await this.findJob(tenantId, jobId);
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: job.connectorId } }),
    );
    if (!connector) return;

    const adapter = this.registry.find(connector.provider);
    if (!adapter) {
      await this.failJobUnsupported(tenantId, jobId, connector.provider);
      return;
    }

    const chunk = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(SyncJob, { id: jobId, tenantId }, { status: SyncJobStatus.RUNNING });
      await manager.update(
        HistoricalBackfillChunk,
        { id: chunkId, tenantId },
        { status: HistoricalBackfillChunkStatus.RUNNING, startedAt: new Date() },
      );
      return manager.findOneByOrFail(HistoricalBackfillChunk, { id: chunkId, tenantId });
    });

    let outcome;
    try {
      outcome = await adapter.fetchChunk(connector, job.datasetKey!, chunk.rangeStart, chunk.rangeEnd, chunk.checkpointCursor);
    } catch (err) {
      outcome = {
        status: 'failed' as const,
        recordsFound: 0,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsDuplicate: 0,
        errorDetails: { reason: 'adapter_threw', message: (err as Error).message },
      };
    }

    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const chunkStatus =
        outcome.status === 'completed' ? HistoricalBackfillChunkStatus.COMPLETED : HistoricalBackfillChunkStatus.FAILED;
      await manager.update(
        HistoricalBackfillChunk,
        { id: chunkId, tenantId },
        {
          status: chunkStatus,
          recordsFound: outcome.recordsFound,
          recordsProcessed: outcome.recordsProcessed,
          recordsFailed: outcome.recordsFailed,
          recordsDuplicate: outcome.recordsDuplicate,
          checkpointCursor: outcome.checkpointCursor ?? null,
          errorDetails: outcome.errorDetails ?? null,
          completedAt: new Date(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      );

      const remaining = await manager.count(HistoricalBackfillChunk, {
        where: { tenantId, syncJobId: jobId, status: HistoricalBackfillChunkStatus.QUEUED },
      });
      const jobUpdate: Partial<SyncJob> = {
        recordsFound: (job.recordsFound ?? 0) + outcome.recordsFound,
        recordsProcessed: job.recordsProcessed + outcome.recordsProcessed,
        recordsFailed: job.recordsFailed + outcome.recordsFailed,
        recordsDuplicate: (job.recordsDuplicate ?? 0) + outcome.recordsDuplicate,
      };
      if (chunkStatus === HistoricalBackfillChunkStatus.FAILED) {
        jobUpdate.status = SyncJobStatus.FAILED;
        jobUpdate.completedAt = new Date();
        jobUpdate.errorDetails = outcome.errorDetails ?? null;
      } else if (remaining === 0) {
        jobUpdate.status = SyncJobStatus.COMPLETED;
        jobUpdate.completedAt = new Date();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await manager.update(SyncJob, { id: jobId, tenantId }, jobUpdate as any);
    });

    // Real "Raw Data" landing (spec §38) - only for an adapter that
    // actually returns rows (`DatabaseHistoricalAdapter`); an adapter
    // that lands data some other way of its own simply omits `records`.
    if (outcome.records && outcome.records.length > 0) {
      await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.save(
          HistoricalRecord,
          outcome.records!.map((rawData) => ({ id: randomUUID(), tenantId, syncJobId: jobId, chunkId, rawData })),
        ),
      );
    }
  }

  private async failJobUnsupported(tenantId: string, jobId: string, provider: string): Promise<void> {
    const error = new HistoricalImportNotSupportedError(provider);
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(
        SyncJob,
        { id: jobId, tenantId },
        {
          status: SyncJobStatus.FAILED,
          completedAt: new Date(),
          errorDetails: { reason: 'historical_import_not_supported', provider, code: error.code },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      );
      await manager.update(
        HistoricalBackfillChunk,
        { tenantId, syncJobId: jobId, status: HistoricalBackfillChunkStatus.QUEUED },
        { status: HistoricalBackfillChunkStatus.CANCELLED },
      );
    });
  }
}

function buildChunkRanges(rangeStart: string, rangeEnd: string, chunkSizeDays: number): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let cursor = new Date(`${rangeStart}T00:00:00Z`);
  const end = new Date(`${rangeEnd}T00:00:00Z`);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkSizeDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: toDateString(cursor), end: toDateString(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
