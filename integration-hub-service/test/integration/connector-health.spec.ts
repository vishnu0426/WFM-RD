import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ConnectorType, SyncJobStatus } from '../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { ConnectorHealthResolver } from '../../src/connectors/graphql/connector-health.resolver';
import { makeRealSyncJobsService, closeRealSyncJobsServiceConnections } from './helpers/real-sync-jobs-service';

dotenv.config();

/**
 * §7 Phase 8's connector health dashboard, real end to end: real Postgres,
 * real Vault. `ConnectorHealthResolver` is called directly (own copy of
 * every other resolver test's own pattern in this suite - no full Nest
 * HTTP bootstrap anywhere in this repo), wrapped in a real
 * `TenantContextService.run()` scope the same way `TenantContextMiddleware`
 * wraps a real request - proving `requireTenantId()` resolves correctly
 * across the resolver's own `await` chain, not just synchronously.
 */
describe('ConnectorHealthResolver (real Postgres + real Vault)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let syncJobs: SyncJobsService;
  let tenantContext: TenantContextService;
  let resolver: ConnectorHealthResolver;
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const createdConnectorIds: string[] = [];

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

    vault = new VaultClientService({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
    });
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService(), { record: async () => undefined } as any);
    syncJobs = makeRealSyncJobsService(appDataSource);
    tenantContext = new TenantContextService();
    resolver = new ConnectorHealthResolver(connectors, syncJobs, tenantContext);
  });

  afterAll(async () => {
    await closeRealSyncJobsServiceConnections();
    if (createdConnectorIds.length) {
      const migrator = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST ?? 'localhost',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
        password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
        database: process.env.DB_DATABASE ?? 'agno_wfm',
        entities,
        synchronize: false,
      });
      await migrator.initialize();
      await migrator.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [createdConnectorIds]);
      await migrator.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migrator.destroy();
    }
    await appDataSource.destroy();
  });

  it('reports real recent sync history and no active streaming session for a batch connector', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'Workday',
      credentials: { accessToken: 'unused-for-this-test' },
    });
    createdConnectorIds.push(connector.id);

    const job1 = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
    await syncJobs.complete(tenantId, job1.id, {
      status: SyncJobStatus.COMPLETED,
      recordsProcessed: 4,
      recordsFailed: 0,
    });
    const job2 = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
    await syncJobs.complete(tenantId, job2.id, { status: SyncJobStatus.FAILED, recordsProcessed: 0, recordsFailed: 1 });

    const health = await tenantContext.run({ tenantId }, () => resolver.connectorHealth(connector.id));

    expect(health.connectorId).toBe(connector.id);
    expect(health.provider).toBe('Workday');
    expect(health.connectorType).toBe(ConnectorType.HRIS);
    expect(health.hasActiveStreamingSession).toBe(false);
    expect(health.recentSyncJobs).toHaveLength(2);
    // Most recent first.
    expect(health.recentSyncJobs[0].id).toBe(job2.id);
    expect(health.recentSyncJobs[0].status).toBe(SyncJobStatus.FAILED);
    expect(health.recentSyncJobs[1].id).toBe(job1.id);
  });

  it('reports an active streaming session for a running acd connector, and connectorsHealth aggregates every connector', async () => {
    const { connector: streamingConnector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Genesys Cloud',
      credentials: { clientId: 'unused', clientSecret: 'unused' },
    });
    createdConnectorIds.push(streamingConnector.id);

    const streamingJob = await syncJobs.enqueue(tenantId, streamingConnector.id, SyncType.STREAMING);
    await syncJobs.markRunning(tenantId, streamingJob.id);

    const health = await tenantContext.run({ tenantId }, () => resolver.connectorHealth(streamingConnector.id));
    expect(health.hasActiveStreamingSession).toBe(true);

    const allHealth = await tenantContext.run({ tenantId }, () => resolver.connectorsHealth());
    const ids = allHealth.map((h) => h.connectorId);
    expect(ids).toEqual(expect.arrayContaining(createdConnectorIds));

    // Real cleanup of the still-`running` job so it doesn't linger past this test.
    await syncJobs.complete(tenantId, streamingJob.id, {
      status: SyncJobStatus.COMPLETED,
      recordsProcessed: 0,
      recordsFailed: 0,
      recordsConflicted: null,
    });
  });

  it('rejects an unknown connectorId with a real ConnectorNotFoundError', async () => {
    await expect(tenantContext.run({ tenantId }, () => resolver.connectorHealth(randomUUID()))).rejects.toThrow(
      'No IntegrationConnector found',
    );
  });
});
