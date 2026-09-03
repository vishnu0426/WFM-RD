import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { entities } from '../../src/database/entities';
import { ConnectorType, SyncJobStatus } from '../../src/integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { FieldMappingsService } from '../../src/connectors/field-mappings.service';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { closeRealSyncJobsServiceConnections, makeRealSyncJobsService } from './helpers/real-sync-jobs-service';
import { RelayAdapterRegistry } from '../../src/sync/relay/relay-adapter-registry.service';
import { StreamingRelayService } from '../../src/sync/relay/streaming-relay.service';
import { NiceCxoneAdapter } from '../../src/sync/relay/providers/nice-cxone.adapter';
import { IntradayActivityEventClient } from '../../src/sync/relay/providers/intraday-activity-event-client';

dotenv.config();

function waitUntil<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      const value = await check();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitUntil timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, intervalMs);
    };
    void attempt();
  });
}

/**
 * §7 Phase 6b's second streaming adapter, real end to end: real Postgres,
 * real Vault, a real local server standing in for NICE CXone's own
 * Resource Owner Password Grant auth plus its `get-next-event` comet
 * long-poll endpoint, and the REAL, already-running Module 05
 * `activity-events`/`agentLiveState`. `GenesysCloudAdapter`'s own Phase 6
 * test already proves the shared relay machinery (backpressure, dedupe,
 * `SyncJob` counters) in depth - this test's value-add is specifically
 * NICE CXone's own transport: the comet pattern's "empty poll, poll
 * again immediately" behavior (first poll here deliberately returns zero
 * events) followed by a real event landing.
 */
describe('NiceCxoneAdapter (real Postgres + real Vault + real local NICE-CXone-shaped server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let niceServer: Server;
  let niceApiBaseUrl: string;
  let pollCount = 0;
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const niceAgentId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const niceUsername = `nice-user-${suffix}`;
  const nicePassword = `nice-pass-${suffix}`;
  const niceClientId = `nice-client-${suffix}`;
  const niceClientSecret = `nice-secret-${suffix}`;
  const createdConnectorIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.VAULT_ADDR || !process.env.VAULT_TOKEN) {
      throw new Error('VAULT_ADDR/VAULT_TOKEN must be set to run this integration test.');
    }
    if (!process.env.INTRADAY_SERVICE_URL || !process.env.INTRADAY_INGESTION_HMAC_SECRETS) {
      throw new Error('INTRADAY_SERVICE_URL/INTRADAY_INGESTION_HMAC_SECRETS must be set to run this integration test.');
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
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService());
    fieldMappings = new FieldMappingsService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    niceServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url === '/token/oauth2') {
          const expected = `Basic ${Buffer.from(`${niceClientId}:${niceClientSecret}`).toString('base64')}`;
          const expectedBody = `grant_type=password&username=${encodeURIComponent(niceUsername)}&password=${encodeURIComponent(nicePassword)}`;
          if (req.headers.authorization !== expected || body !== expectedBody) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ access_token: 'fake-nice-access-token' }));
          return;
        }

        if (req.method === 'GET' && req.url === `/get-next-event?agentIds=${niceAgentId}`) {
          pollCount++;
          res.statusCode = 200;
          if (pollCount === 1) {
            // The comet pattern's own normal "polled early, nothing yet"
            // outcome - a real, expected empty result, not an error.
            res.end(JSON.stringify({ events: [] }));
            return;
          }
          res.end(
            JSON.stringify({
              events: [
                {
                  agentId: niceAgentId,
                  eventType: 'AgentStateChanged',
                  state: 'On Queue',
                  timestamp: new Date().toISOString(),
                },
              ],
            }),
          );
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown path' }));
      });
    });
    await new Promise<void>((resolve) => niceServer.listen(0, '127.0.0.1', resolve));
    const address = niceServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake NICE CXone server');
    niceApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => niceServer.close(() => resolve()));
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
    if (createdConnectorIds.length) {
      await migrator.query(`DELETE FROM integration_hub.field_mapping WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migrator.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [createdConnectorIds]);
      await migrator.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migrator.destroy();
    await closeRealSyncJobsServiceConnections();
    await appDataSource.destroy();
  });

  it('long-polls through a real empty comet cycle, then relays a real event into Module 05 AgentLiveState', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'NICE CXone',
      credentials: {
        username: niceUsername,
        password: nicePassword,
        clientId: niceClientId,
        clientSecret: niceClientSecret,
      },
      additionalConfig: { niceApiBaseUrl, niceAgentIds: [niceAgentId], longPollHoldSeconds: 5 },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'agentId',
      targetField: 'employeeId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'state',
      targetField: 'currentActivity',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'timestamp',
      targetField: 'activityStartedAt',
    });

    const adapter = new NiceCxoneAdapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([adapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: niceAgentId },
          }),
        });
        const respBody = (await response.json()) as { data?: { agentLiveState?: { currentActivity: string | null } } };
        return respBody.data?.agentLiveState ?? undefined;
      };

      const liveState = await waitUntil(async () => {
        const state = await queryLiveState();
        return state?.currentActivity === 'On Queue' ? state : undefined;
      }, 8000);
      expect(liveState.currentActivity).toBe('On Queue');
      expect(pollCount).toBeGreaterThanOrEqual(2);

      await relayService.stop(tenantId, connector.id);
      stopped = true;
      const stoppedJob = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(stoppedJob?.status).toBe(SyncJobStatus.COMPLETED);
    } finally {
      if (!stopped) {
        await relayService.stop(tenantId, connector.id).catch(() => undefined);
      }
    }
  }, 30000);
});
