import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Server, Socket, createServer } from 'node:net';
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
import { AvayaAuraAdapter } from '../../src/sync/relay/providers/avaya-aura.adapter';
import { IntradayActivityEventClient } from '../../src/sync/relay/providers/intraday-activity-event-client';
import { CSTA_EVENT_INVOKE_ID, CstaFrameReader, encodeCstaFrame } from '../../src/sync/relay/providers/csta-xml-frame';

dotenv.config();

const CSTA_NS = 'http://www.ecma-international.org/standards/ecma-323/csta/ed6';

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
 * ADR-0168's real end-to-end verification, same posture as the other
 * streaming-adapter suites: real Postgres, real Vault, plus - since no
 * licensed Avaya AES instance exists anywhere to test against, the actual
 * blocker ADR-0142/ADR-0168 both describe - a real local TCP server that
 * decodes/encodes ECMA-323 Annex J framing exactly as specified and speaks
 * the schema-verified `RequestSystemStatus`/`MonitorStart` service shapes
 * this adapter sends, using `CstaFrameReader`/`encodeCstaFrame` from the
 * same module the adapter itself uses (so this test is proof the adapter's
 * *encoding* matches the public standard, not proof it matches a real AES -
 * see the adapter's own class doc comment for exactly what remains
 * unverified against that).
 */
describe('AvayaAuraAdapter (real Postgres + real Vault + real local ECMA-323 CSTA-XML server + REAL Module 05 activity-events)', () => {
  let appDataSource: DataSource;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let fieldMappings: FieldMappingsService;
  let syncJobs: SyncJobsService;
  let aesServer: Server;
  let aesPort: number;
  let aesSocket: Socket | undefined;
  let receivedSecurityHex: string | undefined;
  const receivedMonitorDeviceIds: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const agentDeviceId = '4711';
  // ADR-0138's "source IDs must already align with Module 02's own
  // identifiers" posture, restated for this adapter's `agentID` field:
  // Module 05's `ActivityEventDto.employeeId` is `@IsUUID()`, so the CSTA
  // `agentID` a real AES would send has to already be a valid employee
  // UUID - a human-readable extension like "4711" (used for the CSTA
  // deviceID above, which is a separate, unconstrained field) would be
  // rejected here exactly as it would be by the real endpoint.
  const agentEmployeeId = randomUUID();
  const securityToken = `secret-${suffix}`;
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

    aesServer = createServer((socket) => {
      aesSocket = socket;
      const reader = new CstaFrameReader();
      socket.on('data', (chunk: Buffer) => {
        for (const frame of reader.push(chunk)) {
          if (frame.xml.includes('<RequestSystemStatus')) {
            const match = /<security>([0-9a-f]*)<\/security>/.exec(frame.xml);
            receivedSecurityHex = match?.[1];
            socket.write(
              encodeCstaFrame(
                frame.invokeId,
                `<?xml version="1.0" encoding="UTF-8"?><RequestSystemStatusResponse xmlns="${CSTA_NS}"/>`,
              ),
            );
            continue;
          }
          if (frame.xml.includes('<MonitorStart')) {
            const match = /<deviceObject>([^<]*)<\/deviceObject>/.exec(frame.xml);
            const deviceId = match?.[1] ?? '';
            receivedMonitorDeviceIds.push(deviceId);
            socket.write(
              encodeCstaFrame(
                frame.invokeId,
                `<?xml version="1.0" encoding="UTF-8"?><MonitorStartResponse xmlns="${CSTA_NS}"><monitorCrossRefID>xref-${deviceId}</monitorCrossRefID></MonitorStartResponse>`,
              ),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => aesServer.listen(0, '127.0.0.1', resolve));
    const address = aesServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake AES server');
    aesPort = address.port;
  });

  afterAll(async () => {
    aesSocket?.destroy();
    await new Promise<void>((resolve) => aesServer.close(() => resolve()));

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

  it('bootstraps a real CSTA association, monitors a device, relays AgentReadyEvent through to a real Module 05 AgentLiveState, and does not dedupe a retransmit (disclosed gap: no vendor event ID)', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.ACD,
      provider: 'Avaya Aura Contact Center / CMS',
      credentials: { securityToken },
      additionalConfig: {
        aesHost: '127.0.0.1',
        aesPort,
        monitoredDeviceIds: [agentDeviceId],
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
      sourceField: 'activity',
      targetField: 'currentActivity',
    });
    await fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField: 'receivedAtIso',
      targetField: 'activityStartedAt',
    });

    const avayaAdapter = new AvayaAuraAdapter(vault, fieldMappings, new IntradayActivityEventClient());
    const registry = new RelayAdapterRegistry([avayaAdapter]);
    const relayService = new StreamingRelayService(appDataSource, syncJobs, registry);

    let stopped = false;
    try {
      const job = await relayService.start(tenantId, connector.id);
      expect(job.status).toBe(SyncJobStatus.RUNNING);

      // Real proof the bootstrap dance happened: the security material this
      // module placed in `RequestSystemStatus`'s `<security>` extension
      // hex-decodes back to the tenant's real credential, and MonitorStart
      // was issued for exactly the configured device.
      await waitUntil(() => receivedSecurityHex);
      expect(Buffer.from(receivedSecurityHex ?? '', 'hex').toString('utf8')).toBe(securityToken);
      await waitUntil(() => (receivedMonitorDeviceIds.length > 0 ? receivedMonitorDeviceIds : undefined));
      expect(receivedMonitorDeviceIds).toEqual([agentDeviceId]);

      await waitUntil(() => aesSocket);
      if (!aesSocket) throw new Error('unreachable - waitUntil guarantees this');
      const socket = aesSocket;

      const sendAgentReadyEvent = () =>
        socket.write(
          encodeCstaFrame(
            CSTA_EVENT_INVOKE_ID,
            `<?xml version="1.0" encoding="UTF-8"?><AgentReadyEvent xmlns="${CSTA_NS}"><monitorCrossRefID>xref-${agentDeviceId}</monitorCrossRefID><agentDevice><deviceIdentifier>${agentDeviceId}</deviceIdentifier></agentDevice><agentID>${agentEmployeeId}</agentID></AgentReadyEvent>`,
          ),
        );

      sendAgentReadyEvent();

      const queryLiveState = async (): Promise<{ currentActivity: string | null } | undefined> => {
        const response = await fetch(`${process.env.INTRADAY_SERVICE_URL}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            query: `query($employeeId: ID!) { agentLiveState(employeeId: $employeeId) { employeeId currentActivity } }`,
            variables: { employeeId: agentEmployeeId },
          }),
        });
        const body = (await response.json()) as { data?: { agentLiveState?: { currentActivity: string | null } } };
        return body.data?.agentLiveState ?? undefined;
      };

      const liveState = await waitUntil(async () => {
        const state = await queryLiveState();
        return state?.currentActivity === 'ready' ? state : undefined;
      });
      expect(liveState.currentActivity).toBe('ready');

      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        return latest && latest.recordsProcessed >= 1 ? latest : undefined;
      });

      // Disclosed gap (2) from the adapter's own class doc comment: unlike
      // Genesys/AXP, these CSTA events carry no vendor-supplied unique ID,
      // so a byte-identical retransmit is NOT deduped by Module 05 - it
      // counts as a second forwarded event. This assertion is proof of
      // that real, disclosed limitation, not proof of idempotency.
      sendAgentReadyEvent();
      await waitUntil(async () => {
        const latest = await syncJobs.findLatestForConnector(tenantId, connector.id);
        return latest && latest.recordsProcessed >= 2 ? latest : undefined;
      });
      const afterRetransmit = await syncJobs.findLatestForConnector(tenantId, connector.id);
      expect(afterRetransmit?.recordsProcessed).toBe(2);

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
