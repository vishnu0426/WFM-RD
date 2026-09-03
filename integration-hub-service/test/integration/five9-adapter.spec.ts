import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
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
import { Five9Adapter } from '../../src/sync/relay/providers/five9.adapter';
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
 * §7 Phase 6b's third streaming adapter, real end to end: real Postgres,
 * real Vault, a real local HTTP+WebSocket server standing in for Five9's
 * own session-authenticate-then-WebSocket surface, and the REAL,
 * already-running Module 05 `activity-events`/`agentLiveState`. As with
 * `NiceCxoneAdapter`'s test, the shared relay machinery is already proven
 * by `GenesysCloudAdapter`'s Phase 6 test - this test's value-add is
 * specifically Five9's own simpler two-step (no channel/topic
 * subscription) session-then-socket dance.
 */
describe('Five9Adapter (real Postgres + real Vault + real local Five9-shaped server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let five9HttpServer: Server;
  let five9WsServer: WebSocketServer;
  let five9ApiBaseUrl: string;
  let five9Socket: WsClient | undefined;
  let receivedSessionHeader: string | undefined;
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const five9AgentId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const five9Username = `five9-user-${suffix}`;
  const five9Password = `five9-pass-${suffix}`;
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

    five9WsServer = new WebSocketServer({ port: 0 });
    five9WsServer.on('connection', (socket, req) => {
      receivedSessionHeader = req.headers['x-five9-session-id'] as string | undefined;
      five9Socket = socket;
    });
    const wsAddress = five9WsServer.address();
    if (!wsAddress || typeof wsAddress === 'string') throw new Error('failed to start fake Five9 WS server');
    const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

    five9HttpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url === '/authenticate') {
          const parsed = JSON.parse(body) as { username?: string; password?: string };
          if (parsed.username !== five9Username || parsed.password !== five9Password) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_credentials' }));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ sessionId: 'fake-five9-session-id', webSocketUri: wsUrl }));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown path' }));
      });
    });
    await new Promise<void>((resolve) => five9HttpServer.listen(0, '127.0.0.1', resolve));
    const httpAddress = five9HttpServer.address();
    if (!httpAddress || typeof httpAddress === 'string') throw new Error('failed to start fake Five9 HTTP server');
    five9ApiBaseUrl = `http://127.0.0.1:${httpAddress.port}`;
  });

  afterAll(async () => {
    for (const client of five9WsServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => five9HttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => five9WsServer.close(() => resolve()));

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

  it('authenticates a real Five9 session, opens the resulting WebSocket, and relays a real event into Module 05 AgentLiveState', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Five9',
      credentials: { username: five9Username, password: five9Password },
      additionalConfig: { five9ApiBaseUrl },
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
      sourceField: 'occurredAt',
      targetField: 'activityStartedAt',
    });

    const adapter = new Five9Adapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([adapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      await waitUntil(() => five9Socket);
      if (!five9Socket) throw new Error('unreachable - waitUntil guarantees this');
      expect(receivedSessionHeader).toBe('fake-five9-session-id');

      five9Socket.send(
        JSON.stringify({
          type: 'AgentStateChanged',
          agentId: five9AgentId,
          state: 'On Queue',
          occurredAt: new Date().toISOString(),
        }),
      );

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: five9AgentId },
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
