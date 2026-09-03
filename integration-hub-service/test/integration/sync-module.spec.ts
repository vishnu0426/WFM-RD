import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Pool } from 'pg';
import { entities } from '../../src/database/entities';
import {
  ConnectorStatus,
  ConnectorType,
  IntegrationConnector,
  SyncJobStatus,
} from '../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';
import { ProviderRateLimitConfigService } from '../../src/sync/provider-rate-limit-config.service';
import { BatchAdapterRegistry } from '../../src/sync/batch/batch-adapter-registry.service';
import { RateLimiterService } from '../../src/sync/batch/rate-limiter.service';
import { BatchSyncRunnerService } from '../../src/sync/batch/batch-sync-runner.service';
import { RelayAdapterRegistry } from '../../src/sync/relay/relay-adapter-registry.service';
import { StreamingRelayService } from '../../src/sync/relay/streaming-relay.service';
import { SyncNotSupportedForConnectorTypeError } from '../../src/sync/errors/sync-not-supported-for-connector-type.error';
import { RelayNotSupportedForConnectorTypeError } from '../../src/sync/errors/relay-not-supported-for-connector-type.error';
import { NoActiveRelaySessionError } from '../../src/sync/errors/no-active-relay-session.error';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/** Real Postgres, including the migrator-pool cross-tenant read the batch runner's `tick()` depends on (ADR: `migrator-pool.provider.ts`). */
describe('Batch-runner base + streaming-relay base (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorPool: Pool;
  let syncJobs: SyncJobsService;
  let rateLimiter: RateLimiterService;
  const tenantId = randomUUID();
  const createdConnectorIds: string[] = [];

  async function createConnector(connectorType: ConnectorType, provider: string): Promise<IntegrationConnector> {
    const id = randomUUID();
    createdConnectorIds.push(id);
    return appDataSource.transaction(async (manager) => {
      await manager.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
      return manager.save(IntegrationConnector, {
        id,
        tenantId,
        connectorType,
        provider,
        status: ConnectorStatus.ACTIVE,
        config: {},
        lastSyncAt: null,
        lastSyncStatus: null,
      });
    });
  }

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_integration_hub_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    migratorPool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      max: 2,
    });

    syncJobs = makeRealSyncJobsService(appDataSource);
    rateLimiter = new RateLimiterService(new ProviderRateLimitConfigService(appDataSource));
  });

  afterAll(async () => {
    if (createdConnectorIds.length) {
      // sync_job rows FK-reference their connector - delete children first.
      await migratorPool.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migratorPool.end();
    await closeRealSyncJobsServiceConnections();
    await appDataSource.destroy();
  });

  describe('BatchSyncRunnerService', () => {
    it('tick(): a connector with no registered adapter gets a cleanly-failed SyncJob, not a fabricated success', async () => {
      const connector = await createConnector(ConnectorType.HRIS, `NoAdapterProvider-${randomUUID()}`);
      const runner = new BatchSyncRunnerService(
        migratorPool,
        appDataSource,
        syncJobs,
        new BatchAdapterRegistry([]),
        rateLimiter,
        new MetricsService(),
      );

      await runner.tick();

      const job = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(job).not.toBeNull();
      expect(job!.status).toBe(SyncJobStatus.FAILED);
      expect(job!.errorDetails).toMatchObject({ reason: 'no_adapter_registered' });
    });

    it("tick(): a connector with a registered adapter completes with the adapter's real outcome", async () => {
      const provider = `RealAdapterProvider-${randomUUID()}`;
      const connector = await createConnector(ConnectorType.PAYROLL, provider);
      const adapter = {
        provider,
        sync: jest.fn().mockResolvedValue({
          status: SyncJobStatus.COMPLETED,
          recordsProcessed: 42,
          recordsFailed: 1,
        }),
      };
      const runner = new BatchSyncRunnerService(
        migratorPool,
        appDataSource,
        syncJobs,
        new BatchAdapterRegistry([adapter]),
        rateLimiter,
        new MetricsService(),
      );

      await runner.tick();

      expect(adapter.sync).toHaveBeenCalledTimes(1);
      const job = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(job!.status).toBe(SyncJobStatus.COMPLETED);
      expect(job!.recordsProcessed).toBe(42);
      expect(job!.recordsFailed).toBe(1);
    });

    it('tick(): never picks up a connector that already has a running SyncJob (overlap guard)', async () => {
      const provider = `OverlapProvider-${randomUUID()}`;
      const connector = await createConnector(ConnectorType.CRM, provider);
      await syncJobs
        .enqueue(tenantId, connector.id, SyncType.INCREMENTAL)
        .then((job) => syncJobs.markRunning(tenantId, job.id));
      const adapter = { provider, sync: jest.fn() };
      const runner = new BatchSyncRunnerService(
        migratorPool,
        appDataSource,
        syncJobs,
        new BatchAdapterRegistry([adapter]),
        rateLimiter,
        new MetricsService(),
      );

      await runner.tick();

      expect(adapter.sync).not.toHaveBeenCalled();
    });

    it('triggerManualSync rejects a streaming (acd) connector', async () => {
      const connector = await createConnector(ConnectorType.ACD, `AcdForBatchRejection-${randomUUID()}`);
      const runner = new BatchSyncRunnerService(
        migratorPool,
        appDataSource,
        syncJobs,
        new BatchAdapterRegistry([]),
        rateLimiter,
        new MetricsService(),
      );

      await expect(runner.triggerManualSync(tenantId, connector.id)).rejects.toThrow(
        SyncNotSupportedForConnectorTypeError,
      );
    });
  });

  describe('StreamingRelayService', () => {
    it('start(): no registered adapter -> cleanly-failed SyncJob(sync_type: streaming)', async () => {
      const connector = await createConnector(ConnectorType.ACD, `NoRelayAdapter-${randomUUID()}`);
      const relay = new StreamingRelayService(appDataSource, syncJobs, new RelayAdapterRegistry([]));

      const job = await relay.start(tenantId, connector.id);

      expect(job.status).toBe(SyncJobStatus.FAILED);
      expect(job.syncType).toBe(SyncType.STREAMING);
      expect(job.errorDetails).toMatchObject({ reason: 'no_adapter_registered' });
    });

    it('start()/stop(): full lifecycle with a registered adapter - connect called, session tracked, disconnect called on stop', async () => {
      const provider = `RealRelayAdapter-${randomUUID()}`;
      const connector = await createConnector(ConnectorType.ACD, provider);
      const session = { connectorId: connector.id, handle: { fakeSocket: true } };
      const adapter = {
        provider,
        connect: jest.fn().mockResolvedValue(session),
        disconnect: jest.fn().mockResolvedValue(undefined),
      };
      const relay = new StreamingRelayService(appDataSource, syncJobs, new RelayAdapterRegistry([adapter]));

      const started = await relay.start(tenantId, connector.id);
      expect(started.status).toBe(SyncJobStatus.RUNNING);
      expect(adapter.connect).toHaveBeenCalledTimes(1);

      const stopped = await relay.stop(tenantId, connector.id);
      expect(stopped.status).toBe(SyncJobStatus.COMPLETED);
      expect(stopped.completedAt).not.toBeNull();
      expect(adapter.disconnect).toHaveBeenCalledWith(session);
    });

    it('stop(): no active session -> NoActiveRelaySessionError', async () => {
      const connector = await createConnector(ConnectorType.ACD, `NeverStarted-${randomUUID()}`);
      const relay = new StreamingRelayService(appDataSource, syncJobs, new RelayAdapterRegistry([]));

      await expect(relay.stop(tenantId, connector.id)).rejects.toThrow(NoActiveRelaySessionError);
    });

    it('start(): rejects a non-acd connector type', async () => {
      const connector = await createConnector(ConnectorType.HRIS, `HrisForRelayRejection-${randomUUID()}`);
      const relay = new StreamingRelayService(appDataSource, syncJobs, new RelayAdapterRegistry([]));

      await expect(relay.start(tenantId, connector.id)).rejects.toThrow(RelayNotSupportedForConnectorTypeError);
    });

    it('status(): reflects the most recent streaming SyncJob for the connector', async () => {
      const connector = await createConnector(ConnectorType.ACD, `StatusCheck-${randomUUID()}`);
      const relay = new StreamingRelayService(appDataSource, syncJobs, new RelayAdapterRegistry([]));

      expect(await relay.status(tenantId, connector.id)).toBeNull();
      await relay.start(tenantId, connector.id);
      const status = await relay.status(tenantId, connector.id);
      expect(status).not.toBeNull();
      expect(status!.syncType).toBe(SyncType.STREAMING);
    });
  });
});
