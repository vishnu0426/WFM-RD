import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server, ServerResponse } from 'node:http';
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
import { TalkdeskAdapter } from '../../src/sync/relay/providers/talkdesk.adapter';
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
 * §7 Phase 6b's fourth streaming adapter, and the only one over Server-
 * Sent Events rather than a WebSocket - real end to end: real Postgres,
 * real Vault, a real local server standing in for Talkdesk's own OAuth2 +
 * Live API subscribe-then-SSE-stream surface, and the REAL, already-
 * running Module 05 `activity-events`/`agentLiveState`. This test's
 * value-add over `GenesysCloudAdapter`'s already-proven relay machinery is
 * specifically the raw SSE frame parsing (`data:` lines split on the real
 * blank-line delimiter) `TalkdeskAdapter` implements itself, with no
 * `EventSource` global available in Node.
 */
describe('TalkdeskAdapter (real Postgres + real Vault + real local Talkdesk-shaped SSE server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let talkdeskServer: Server;
  let talkdeskApiBaseUrl: string;
  let sseResponse: ServerResponse | undefined;
  let receivedMetrics: string[] | undefined;
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const talkdeskAgentId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const talkdeskClientId = `talkdesk-client-${suffix}`;
  const talkdeskClientSecret = `talkdesk-secret-${suffix}`;
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

    talkdeskServer = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/oauth/token') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            client_id?: string;
            client_secret?: string;
          };
          res.setHeader('Content-Type', 'application/json');
          if (parsed.client_id !== talkdeskClientId || parsed.client_secret !== talkdeskClientSecret) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ access_token: 'fake-talkdesk-access-token' }));
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/live-data/subscriptions') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { metrics?: string[] };
          receivedMetrics = parsed.metrics;
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify({ subscriptionId: 'fake-talkdesk-subscription-id' }));
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/live-data/subscriptions/fake-talkdesk-subscription-id/stream') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        sseResponse = res;
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unknown path' }));
    });
    await new Promise<void>((resolve) => talkdeskServer.listen(0, '127.0.0.1', resolve));
    const address = talkdeskServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake Talkdesk server');
    talkdeskApiBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    sseResponse?.end();
    // A hard fallback (Node 18.2+): an SSE response left open by a test
    // failure that never reached `relayService.stop()` would otherwise
    // hold this connection open and hang the server's own `close()`
    // callback indefinitely, the same class of bug the Genesys Cloud
    // adapter's own test first surfaced (ADR-0141's design doc).
    talkdeskServer.closeAllConnections?.();
    await new Promise<void>((resolve) => talkdeskServer.close(() => resolve()));

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

  it('subscribes over real OAuth2, opens a real SSE stream, and relays a real frame into Module 05 AgentLiveState', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Talkdesk',
      credentials: { clientId: talkdeskClientId, clientSecret: talkdeskClientSecret },
      additionalConfig: { talkdeskApiBaseUrl },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'agentId',
      targetField: 'employeeId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'status',
      targetField: 'currentActivity',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'updatedAt',
      targetField: 'activityStartedAt',
    });

    const adapter = new TalkdeskAdapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([adapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      await waitUntil(() => sseResponse);
      if (!sseResponse) throw new Error('unreachable - waitUntil guarantees this');
      expect(receivedMetrics).toEqual(['agent_status']);

      const frame = JSON.stringify({
        agentId: talkdeskAgentId,
        status: 'On Queue',
        updatedAt: new Date().toISOString(),
      });
      sseResponse.write(`data: ${frame}\n\n`);

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: talkdeskAgentId },
          }),
        });
        const respBody = (await response.json()) as { data?: { agentLiveState?: { currentActivity: string | null } } };
        return respBody.data?.agentLiveState ?? undefined;
      };

      const liveState = await waitUntil(async () => {
        const state = await queryLiveState();
        return state?.currentActivity === 'On Queue' ? state : undefined;
      });
      expect(liveState.currentActivity).toBe('On Queue');

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
