import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
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
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { FieldMappingsService } from '../../src/connectors/field-mappings.service';
import { FieldAuthorityPoliciesService } from '../../src/connectors/field-authority-policies.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';
import { ProviderRateLimitConfigService } from '../../src/sync/provider-rate-limit-config.service';
import { BatchAdapterRegistry } from '../../src/sync/batch/batch-adapter-registry.service';
import { RateLimiterService } from '../../src/sync/batch/rate-limiter.service';
import { BatchSyncRunnerService } from '../../src/sync/batch/batch-sync-runner.service';
import { BulkImportClientService } from '../../src/sync/batch/providers/bulk-import-client.service';
import { WorkdayAdapter } from '../../src/sync/batch/providers/workday.adapter';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

/**
 * §5a's real end-to-end verification: real Postgres (including the real
 * `ProviderRateLimitConfig` seed data from
 * `1700010100000-SeedProviderRateLimitConfig.ts`), real Vault. Proves the
 * proactive throttle genuinely prevents `adapter.sync()` from ever being
 * called once a connector's bucket is exhausted (§5a: "enforces this
 * *before* making calls"), and that the reactive backoff genuinely retries
 * against a real 429 response and either recovers or gives up cleanly.
 */
describe('§5a rate limiting - real Postgres + real seeded ProviderRateLimitConfig', () => {
  let appDataSource: DataSource;
  let migratorPool: Pool;
  const tenantId = randomUUID();
  const createdConnectorIds: string[] = [];
  const createdRateLimitConfigProviders: string[] = [];

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test.');
    }
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
  });

  afterAll(async () => {
    if (createdConnectorIds.length) {
      await migratorPool.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    if (createdRateLimitConfigProviders.length) {
      await migratorPool.query(`DELETE FROM integration_hub.provider_rate_limit_config WHERE provider = ANY($1)`, [
        createdRateLimitConfigProviders,
      ]);
    }
    await migratorPool.end();
    await closeRealSyncJobsServiceConnections();
    await appDataSource.destroy();
  });

  describe('proactive throttle (BatchSyncRunnerService)', () => {
    it('a connector never reaches adapter.sync() once its real seeded provider bucket is exhausted', async () => {
      // Seed a tiny, dedicated test-only ProviderRateLimitConfig row -
      // real seeded data, just sized for a fast test (capacity 1).
      const testProvider = `ThrottleTestProvider-${randomUUID()}`;
      createdRateLimitConfigProviders.push(testProvider);
      await migratorPool.query(
        `INSERT INTO integration_hub.provider_rate_limit_config (id, provider, requests_per_window, window_seconds, backoff_strategy)
         VALUES (gen_random_uuid(), $1, 1, 60, '{}'::jsonb)`,
        [testProvider],
      );

      const connectorId = randomUUID();
      createdConnectorIds.push(connectorId);
      await appDataSource.transaction(async (manager) => {
        await manager.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
        await manager.save(IntegrationConnector, {
          id: connectorId,
          tenantId,
          connectorType: ConnectorType.HRIS,
          provider: testProvider,
          status: ConnectorStatus.ACTIVE,
          config: {},
          lastSyncAt: null,
          lastSyncStatus: null,
        });
      });

      const syncJobs = makeRealSyncJobsService(appDataSource);
      const rateLimiter = new RateLimiterService(new ProviderRateLimitConfigService(appDataSource));
      const adapter = {
        provider: testProvider,
        sync: jest.fn().mockResolvedValue({ status: SyncJobStatus.COMPLETED, recordsProcessed: 1, recordsFailed: 0 }),
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
      const firstJob = await syncJobs.findLatestForConnector(tenantId, connectorId);
      expect(firstJob!.status).toBe(SyncJobStatus.COMPLETED);

      // Second tick, same (tenant, connector) - bucket has no tokens left.
      await runner.tick();
      expect(adapter.sync).toHaveBeenCalledTimes(1); // still 1 - never called a second time
      const secondJob = await syncJobs.findLatestForConnector(tenantId, connectorId);
      expect(secondJob!.status).toBe(SyncJobStatus.PARTIAL_FAILURE);
      expect(secondJob!.errorDetails).toMatchObject({ reason: 'rate_limited', provider: testProvider });
      expect(secondJob!.id).not.toBe(firstJob!.id);
    });
  });

  describe('reactive backoff (WorkdayAdapter against a real 429)', () => {
    let fakeServer: Server;
    let fakeApiBaseUrl: string;
    let responsePlan: Array<'rate_limited' | 'ok'> = [];
    const workdayToken = 'reactive-fake-token';

    beforeAll(async () => {
      fakeServer = createServer((req, res) => {
        const next = responsePlan.shift() ?? 'ok';
        if (req.headers.authorization !== `Bearer ${workdayToken}`) {
          res.statusCode = 401;
          res.end();
          return;
        }
        if (next === 'rate_limited') {
          res.statusCode = 429;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ data: [] }));
      });
      await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
      const address = fakeServer.address();
      if (!address || typeof address === 'string') throw new Error('failed to start fake server');
      fakeApiBaseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    });

    async function withTemporaryWorkdayBackoff(backoffStrategy: Record<string, unknown>, run: () => Promise<void>) {
      const { rows } = await migratorPool.query(
        `SELECT backoff_strategy FROM integration_hub.provider_rate_limit_config WHERE provider = 'Workday'`,
      );
      const original = rows[0].backoff_strategy;
      await migratorPool.query(
        `UPDATE integration_hub.provider_rate_limit_config SET backoff_strategy = $1::jsonb WHERE provider = 'Workday'`,
        [JSON.stringify(backoffStrategy)],
      );
      try {
        await run();
      } finally {
        await migratorPool.query(
          `UPDATE integration_hub.provider_rate_limit_config SET backoff_strategy = $1::jsonb WHERE provider = 'Workday'`,
          [JSON.stringify(original)],
        );
      }
    }

    it("retries a real 429 using Workday's own seeded backoff_strategy and recovers", async () => {
      await withTemporaryWorkdayBackoff({ type: 'exponential', base_ms: 10, max_retries: 3 }, async () => {
        const vault = new VaultClientService({
          addr: process.env.VAULT_ADDR!,
          token: process.env.VAULT_TOKEN!,
          kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
        });
        const connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService());
        const { connector } = await connectors.create(tenantId, {
          connectorType: ConnectorType.HRIS,
          provider: 'Workday',
          credentials: { accessToken: workdayToken },
          additionalConfig: { workdayApiBaseUrl: fakeApiBaseUrl },
        });
        createdConnectorIds.push(connector.id);

        const metrics = new MetricsService();
        const recordSpy = jest.spyOn(metrics, 'recordRateLimitThrottle');
        const adapter = new WorkdayAdapter(
          vault,
          new FieldMappingsService(appDataSource),
          new FieldAuthorityPoliciesService(appDataSource),
          new BulkImportClientService(),
          new ProviderRateLimitConfigService(appDataSource),
          metrics,
        );

        responsePlan = ['rate_limited', 'ok'];
        const syncJobs = makeRealSyncJobsService(appDataSource);
        const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
        const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

        // No workers returned (empty fixture) -> no_valid_records, but the
        // real proof is that it got *past* the 429 at all, not the outcome shape.
        expect(outcome.status).toBe(SyncJobStatus.FAILED);
        expect(outcome.errorDetails).toMatchObject({ reason: 'no_valid_records' });
        expect(recordSpy).toHaveBeenCalledWith('Workday', 'reactive_retry');
      });
    });

    it('gives up cleanly with a distinct partial_failure reason when the provider never stops returning 429', async () => {
      await withTemporaryWorkdayBackoff({ type: 'exponential', base_ms: 10, max_retries: 2 }, async () => {
        const vault = new VaultClientService({
          addr: process.env.VAULT_ADDR!,
          token: process.env.VAULT_TOKEN!,
          kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
        });
        const connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService());
        const { connector } = await connectors.create(tenantId, {
          connectorType: ConnectorType.HRIS,
          provider: 'Workday',
          credentials: { accessToken: workdayToken },
          additionalConfig: { workdayApiBaseUrl: fakeApiBaseUrl },
        });
        createdConnectorIds.push(connector.id);

        const metrics = new MetricsService();
        const recordSpy = jest.spyOn(metrics, 'recordRateLimitThrottle');
        const adapter = new WorkdayAdapter(
          vault,
          new FieldMappingsService(appDataSource),
          new FieldAuthorityPoliciesService(appDataSource),
          new BulkImportClientService(),
          new ProviderRateLimitConfigService(appDataSource),
          metrics,
        );

        responsePlan = ['rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited'];
        const syncJobs = makeRealSyncJobsService(appDataSource);
        const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
        const outcome = await adapter.sync(await connectors.findByIdForTenant(tenantId, connector.id), job);

        expect(outcome.status).toBe(SyncJobStatus.PARTIAL_FAILURE);
        expect(outcome.errorDetails).toMatchObject({ reason: 'rate_limited_reactive_exhausted' });
        expect(recordSpy).toHaveBeenCalledWith('Workday', 'reactive_exhausted');
      });
    });
  });
});
