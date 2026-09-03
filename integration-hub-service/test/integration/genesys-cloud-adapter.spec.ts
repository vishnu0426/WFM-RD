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
import { GenesysCloudAdapter } from '../../src/sync/relay/providers/genesys-cloud.adapter';
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
 * §7 Phase 6's real end-to-end verification (ADR-0141): real Postgres,
 * real Vault, a real local HTTP+WebSocket server standing in for Genesys
 * Cloud's actual Notifications API three-call provisioning dance plus its
 * WebSocket push (no real credentialed Genesys Cloud org exists in this
 * environment - see the Phase 6 design doc), and the REAL, already-running
 * Module 05 `POST /v1/intraday/tenants/:tenantId/activity-events` plus its
 * real `agentLiveState` GraphQL query (not stand-ins - both exist in this
 * same monorepo and were started for this run against the same Postgres/
 * Redis/NATS).
 *
 * Requires: intraday-service running on INTRADAY_SERVICE_URL with
 * INTRADAY_WEBHOOK_SECRETS containing this test's tenant, matching this
 * service's own INTRADAY_INGESTION_HMAC_SECRETS (both read from `.env` -
 * see the Phase 6 design doc's verification section for the exact startup
 * commands used for this run).
 */
describe('GenesysCloudAdapter (real Postgres + real Vault + real local Genesys-shaped server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let genesysHttpServer: Server;
  let genesysWsServer: WebSocketServer;
  let genesysApiBaseUrl: string;
  let genesysSocket: WsClient | undefined;
  let subscribedTopics: Array<{ id: string }> = [];
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const genesysUserId = randomUUID();
  const genesysClientId = `genesys-client-${suffix}`;
  const genesysClientSecret = `genesys-secret-${suffix}`;
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

    genesysWsServer = new WebSocketServer({ port: 0 });
    genesysWsServer.on('connection', (socket) => {
      genesysSocket = socket;
    });
    const wsAddress = genesysWsServer.address();
    if (!wsAddress || typeof wsAddress === 'string') throw new Error('failed to start fake Genesys WS server');
    const wsUrl = `ws://127.0.0.1:${wsAddress.port}`;

    genesysHttpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST' && req.url === '/oauth/token') {
          const expected = `Basic ${Buffer.from(`${genesysClientId}:${genesysClientSecret}`).toString('base64')}`;
          if (req.headers.authorization !== expected || body !== 'grant_type=client_credentials') {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
          res.statusCode = 200;
          res.end(
            JSON.stringify({ access_token: 'fake-genesys-access-token', token_type: 'bearer', expires_in: 86400 }),
          );
          return;
        }

        if (req.method === 'POST' && req.url === '/api/v2/notifications/channels') {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              id: 'channel-1',
              connectUri: wsUrl,
              expires: new Date(Date.now() + 3600_000).toISOString(),
            }),
          );
          return;
        }

        if (req.method === 'PUT' && req.url === '/api/v2/notifications/channels/channel-1/subscriptions') {
          subscribedTopics = JSON.parse(body) as Array<{ id: string }>;
          res.statusCode = 200;
          res.end(JSON.stringify(subscribedTopics));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown path' }));
      });
    });
    await new Promise<void>((resolve) => genesysHttpServer.listen(0, '127.0.0.1', resolve));
    const httpAddress = genesysHttpServer.address();
    if (!httpAddress || typeof httpAddress === 'string') throw new Error('failed to start fake Genesys HTTP server');
    genesysApiBaseUrl = `http://127.0.0.1:${httpAddress.port}`;
  });

  afterAll(async () => {
    // If the test body threw before reaching `relayService.stop()`, the
    // adapter's own WebSocket client is still connected - `wss.close()`'s
    // callback never fires while any client connection remains open, which
    // would otherwise hang this hook (and the whole suite) indefinitely
    // rather than just failing the one assertion that threw.
    for (const client of genesysWsServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => genesysHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => genesysWsServer.close(() => resolve()));

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

  it('provisions a real Genesys Cloud channel, relays a presence event through to a real Module 05 AgentLiveState, dedupes a retransmit, and drops under real backpressure', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Genesys Cloud',
      credentials: { clientId: genesysClientId, clientSecret: genesysClientSecret },
      additionalConfig: {
        genesysApiBaseUrl,
        genesysUserIds: [genesysUserId],
        // Small on purpose - the backpressure assertion below needs a
        // capacity a rapid-fire burst can genuinely exceed while the first
        // item is still in flight, not a number so large the drop path
        // never actually engages.
        backpressureQueueCapacity: 2,
      },
    });
    createdConnectorIds.push(connector.id);

    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'userId',
      targetField: 'employeeId',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'presenceDefinition.systemPresence',
      targetField: 'currentActivity',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'modifiedDate',
      targetField: 'activityStartedAt',
    });

    const genesysAdapter = new GenesysCloudAdapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([genesysAdapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    // `finally` guarantees `relayService.stop()` runs even if an assertion
    // below throws - without it, the adapter's own WebSocket session (and
    // its reconnect-with-backoff loop, unbounded by design - a real relay
    // should keep retrying forever) stays alive past this test, which
    // would otherwise hang `afterAll`'s fake-server shutdown indefinitely
    // rather than just failing the one assertion that threw.
    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      // Real proof the provisioning dance actually happened against the
      // fake server, not just that a WebSocket eventually appeared: the
      // exact topic this module derived from `genesysUserIds` was
      // subscribed.
      await waitUntil(() => (subscribedTopics.length > 0 ? subscribedTopics : undefined));
      expect(subscribedTopics).toEqual([{ id: `v2.users.${genesysUserId}.presence` }]);

      await waitUntil(() => genesysSocket);
      if (!genesysSocket) throw new Error('unreachable - waitUntil guarantees this');
      const socket = genesysSocket;

      const modifiedDate = new Date().toISOString();
      const sendPresenceFrame = () =>
        socket.send(
          JSON.stringify({
            topicName: `v2.users.${genesysUserId}.presence`,
            eventBody: { presenceDefinition: { systemPresence: 'On Queue' }, modifiedDate },
          }),
        );

      // A heartbeat frame Genesys really does send on every open channel -
      // proof the adapter's own filter ignores it rather than miscounting
      // it as (or crashing on) a presence event.
      socket.send(JSON.stringify({ topicName: 'channel.metadata', message: 'WebSocket Heartbeat' }));

      sendPresenceFrame();

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: genesysUserId },
          }),
        });
        const body = (await response.json()) as { data?: { agentLiveState?: { currentActivity: string | null } } };
        return body.data?.agentLiveState ?? undefined;
      };

      // The real proof: the event actually landed in Module 05's own live
      // state, readable through its real GraphQL query - not asserted from
      // this service's own state. Async (NATS-consumer-mediated) on
      // Module 05's side, so this polls rather than asserting immediately.
      const liveState = await waitUntil(async () => {
        const state = await queryLiveState();
        return state?.currentActivity === 'On Queue' ? state : undefined;
      });
      expect(liveState.currentActivity).toBe('On Queue');

      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        return latest && latest.recordsProcessed >= 1 ? latest : undefined;
      });

      // Idempotency: the exact same frame retransmitted (a real, expected
      // Genesys behavior on reconnect) must not be double-counted by
      // Module 05 - `sourceEventId` is derived from `userId` + Genesys's
      // own `modifiedDate`, so a byte-identical retransmit produces a
      // byte-identical `sourceEventId` and Module 05's own dedupe absorbs
      // it.
      sendPresenceFrame();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterRetransmit = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(afterRetransmit?.recordsProcessed).toBe(1);

      // Real backpressure: fire a burst of distinct events faster than the
      // network round trip to the real intraday-service can drain them,
      // against a queue capacity (2) small enough that this burst
      // genuinely exceeds it - not simulated, an actual `queue_full` drop
      // path.
      // `Date.now() + i` rather than 20 back-to-back `new Date()` calls -
      // a tight synchronous loop resolves faster than the real Date
      // clock's own millisecond granularity, so bare `new Date()` here
      // would produce duplicate timestamps (and therefore duplicate
      // `sourceEventId`s) across several burst frames. That's a genuine
      // Genesys possibility too, but it would make some of this burst
      // resolve as `duplicate` against Module 05 rather than genuinely
      // exercising the queue's own capacity drop path, which is what this
      // assertion is for - each frame here needs a distinct identity.
      for (let i = 0; i < 20; i++) {
        socket.send(
          JSON.stringify({
            topicName: `v2.users.${genesysUserId}.presence`,
            eventBody: {
              presenceDefinition: { systemPresence: `Burst-${i}` },
              modifiedDate: new Date(Date.now() + i).toISOString(),
            },
          }),
        );
      }

      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        // Every burst frame was counted as either forwarded or failed
        // (dropped) - §2.1's own streaming-row semantics: nothing
        // vanishes silently, even under real backpressure.
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
