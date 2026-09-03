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
import { AxpAdapter } from '../../src/sync/relay/providers/axp.adapter';
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
 * ADR-0167's real end-to-end verification, same posture as
 * `genesys-cloud-adapter.spec.ts` (ADR-0141): real Postgres, real Vault, a
 * real local HTTP+WebSocket server standing in for AXP's actual four-step
 * dance sourced live from developers.avayacloud.com (OAuth2 token ->
 * subscription creation -> WebSocket open -> `{event:"authentication"}`
 * handshake), plus the REAL, already-running Module 05
 * `POST /v1/intraday/tenants/:tenantId/activity-events` and its real
 * `agentLiveState` GraphQL query - no real credentialed AXP account exists
 * in this environment.
 *
 * Requires: intraday-service running on INTRADAY_SERVICE_URL with
 * INTRADAY_WEBHOOK_SECRETS containing this test's tenant, matching this
 * service's own INTRADAY_INGESTION_HMAC_SECRETS (both read from `.env`).
 */
describe('AxpAdapter (real Postgres + real Vault + real local AXP-shaped server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let axpHttpServer: Server;
  let axpWsServer: WebSocketServer;
  let axpApiBaseUrl: string;
  let axpSocket: WsClient | undefined;
  let receivedAuthFrame: { event?: string; subscriptionId?: string; token?: string } | undefined;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const axpAccountId = `acct-${suffix}`;
  const axpAgentId = randomUUID();
  const axpClientId = `axp-client-${suffix}`;
  const axpClientSecret = `axp-secret-${suffix}`;
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
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService(), { record: async () => undefined } as any);
    fieldMappings = new FieldMappingsService(appDataSource);
    syncJobs = makeRealSyncJobsService(appDataSource);

    axpWsServer = new WebSocketServer({ port: 0 });
    axpWsServer.on('connection', (socket) => {
      axpSocket = socket;
      socket.once('message', (raw) => {
        receivedAuthFrame = JSON.parse(raw.toString()) as { event?: string; subscriptionId?: string; token?: string };
        socket.send(JSON.stringify({ event: 'authentication', status: 'CONNECTION_CONFIRMED' }));
      });
    });
    const wsAddress = axpWsServer.address();
    if (!wsAddress || typeof wsAddress === 'string') throw new Error('failed to start fake AXP WS server');
    const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

    axpHttpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url === `/api/auth/v1/${axpAccountId}/protocol/openid-connect/token`) {
          const params = new URLSearchParams(body);
          if (
            params.get('grant_type') !== 'client_credentials' ||
            params.get('client_id') !== axpClientId ||
            params.get('client_secret') !== axpClientSecret
          ) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify({ access_token: 'fake-axp-access-token', token_type: 'bearer', expires_in: 900 }));
          return;
        }

        if (req.method === 'POST' && req.url === `/v1/accounts/${axpAccountId}/subscriptions`) {
          const parsed = JSON.parse(body) as { family?: string; events?: string[]; transport?: { type?: string } };
          if (parsed.family !== 'AGENT_ENGAGEMENT' || parsed.transport?.type !== 'WEBSOCKET') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'unsupported subscription request' }));
            return;
          }
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              subscriptionId: 'sub-1',
              transport: { endpoint: wsUrl },
              pingInterval: 300,
              expiresAt: new Date(Date.now() + 86400_000).toISOString(),
              expiresIn: 86400,
              status: 'ACTIVE',
            }),
          );
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown path' }));
      });
    });
    await new Promise<void>((resolve) => axpHttpServer.listen(0, '127.0.0.1', resolve));
    const httpAddress = axpHttpServer.address();
    if (!httpAddress || typeof httpAddress === 'string') throw new Error('failed to start fake AXP HTTP server');
    axpApiBaseUrl = `http://127.0.0.1:${httpAddress.port}`;
  });

  afterAll(async () => {
    // Same rationale as the Genesys suite - a still-connected client would
    // otherwise hang `wss.close()`'s callback indefinitely.
    for (const client of axpWsServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => axpHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => axpWsServer.close(() => resolve()));

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

  it('provisions a real AXP subscription, authenticates the WebSocket, relays an AgentState event through to a real Module 05 AgentLiveState, dedupes a retransmit, and drops under real backpressure', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Avaya Experience Platform',
      credentials: { clientId: axpClientId, clientSecret: axpClientSecret },
      additionalConfig: {
        axpApiBaseUrl,
        axpAccountId,
        // Small on purpose, same rationale as the Genesys suite: the
        // backpressure assertion below needs a capacity a rapid-fire burst
        // can genuinely exceed while the first item is still in flight.
        backpressureQueueCapacity: 2,
      },
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
      sourceField: 'timestampIso',
      targetField: 'activityStartedAt',
    });

    const axpAdapter = new AxpAdapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([axpAdapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      // Real proof the four-step dance actually happened: the WS-level
      // authentication frame this module sent carries the exact
      // `subscriptionId` the fake REST server issued.
      await waitUntil(() => receivedAuthFrame);
      expect(receivedAuthFrame?.event).toBe('authentication');
      expect(receivedAuthFrame?.subscriptionId).toBe('sub-1');
      expect(receivedAuthFrame?.token).toBe('fake-axp-access-token');

      await waitUntil(() => axpSocket);
      if (!axpSocket) throw new Error('unreachable - waitUntil guarantees this');
      const socket = axpSocket;

      const eventId = randomUUID();
      const timestamp = Date.now();
      const sendAgentStateFrame = () =>
        socket.send(
          JSON.stringify({
            correlationId: randomUUID(),
            subscriptionId: 'sub-1',
            family: 'AGENT_ENGAGEMENT',
            sentAt: new Date().toISOString(),
            accountId: axpAccountId,
            loginId: 'agent1@test.com',
            body: {
              event: 'AgentState',
              agentId: axpAgentId,
              profileId: 'HomeProfile',
              state: 'READY',
              id: eventId,
              timestamp,
            },
          }),
        );

      // A real ping ack the adapter must ignore rather than miscounting or
      // crashing on.
      socket.send(JSON.stringify({ event: 'pong' }));

      sendAgentStateFrame();

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: axpAgentId },
          }),
        });
        const body = (await response.json()) as { data?: { agentLiveState?: { currentActivity: string | null } } };
        return body.data?.agentLiveState ?? undefined;
      };

      const liveState = await waitUntil(async () => {
        const state = await queryLiveState();
        return state?.currentActivity === 'READY' ? state : undefined;
      });
      expect(liveState.currentActivity).toBe('READY');

      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        return latest && latest.recordsProcessed >= 1 ? latest : undefined;
      });

      // Idempotency: a byte-identical retransmit (a real possibility on
      // reconnect) must not be double-counted - `sourceEventId` is derived
      // from `agentId` + AXP's own per-event `id`, so the retransmit
      // produces the same `sourceEventId` and Module 05's own dedupe
      // absorbs it.
      sendAgentStateFrame();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterRetransmit = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(afterRetransmit?.recordsProcessed).toBe(1);

      // Real backpressure, same shape as the Genesys suite: a burst of
      // distinct events faster than the real intraday-service round trip
      // can drain them, against a queue capacity (2) small enough to
      // genuinely exceed.
      for (let i = 0; i < 20; i++) {
        socket.send(
          JSON.stringify({
            correlationId: randomUUID(),
            subscriptionId: 'sub-1',
            family: 'AGENT_ENGAGEMENT',
            sentAt: new Date().toISOString(),
            accountId: axpAccountId,
            loginId: 'agent1@test.com',
            body: {
              event: 'AgentState',
              agentId: axpAgentId,
              profileId: 'HomeProfile',
              state: `Burst-${i}`,
              id: randomUUID(),
              timestamp: timestamp + i,
            },
          }),
        );
      }

      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        const total = (latest?.recordsProcessed ?? 0) + (latest?.recordsFailed ?? 0);
        return total >= 21 ? latest : undefined; // the 1 already-forwarded event + this 20-frame burst
      }, 10000);
      const afterBurst = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(afterBurst?.recordsFailed).toBeGreaterThan(0);

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
