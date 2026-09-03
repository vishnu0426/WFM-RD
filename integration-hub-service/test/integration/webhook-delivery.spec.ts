import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { DataSource } from 'typeorm';
import { Pool } from 'pg';
import { connect as connectNats, NatsConnection, StringCodec } from 'nats';
import { entities } from '../../src/database/entities';
import { ConnectorType, SyncJobStatus } from '../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../src/integrations/entities/sync-job.entity';
import { WebhookSubscriptionStatus } from '../../src/integrations/entities/webhook-subscription.entity';
import { VaultClientService } from '../../src/vault/vault-client.service';
import { IntegrationConnectorsService } from '../../src/connectors/integration-connectors.service';
import { OAuthTokenExchangeService } from '../../src/connectors/oauth-token-exchange.service';
import { SyncJobsService } from '../../src/sync/sync-jobs.service';
import { IntegrationHubNatsClientService } from '../../src/webhooks/nats/integration-hub-nats-client.service';
import {
  WebhookSubscriptionsService,
  FAILING_THRESHOLD,
  DISABLED_THRESHOLD,
} from '../../src/webhooks/webhook-subscriptions.service';
import { WebhookDeliveriesService } from '../../src/webhooks/webhook-deliveries.service';
import { WebhookFanoutService } from '../../src/webhooks/webhook-fanout.service';
import { WebhookDeliveryDispatcherService } from '../../src/webhooks/webhook-delivery-dispatcher.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';

dotenv.config();

const codec = StringCodec();

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
 * §7 Phase 7's real end-to-end verification: real Postgres, real Vault,
 * real NATS, a real local HTTP receiver standing in for a tenant's own
 * webhook endpoint. Proves the whole chain `SyncJobsService.complete()`
 * now drives: a real NATS publish landing on the real provisioned
 * `AGNO_INTEGRATION_HUB_EVENTS` stream's subject, and a real HMAC-signed
 * delivery reaching a real receiver that independently recomputes the
 * signature from the secret returned at subscription-creation time (not
 * asserted from this service's own internal state) - plus the real
 * auto-disable escalation under sustained delivery failure.
 */
describe('Webhook delivery (real Postgres + real Vault + real NATS + real local receiver)', () => {
  let appDataSource: DataSource;
  let migratorPool: Pool;
  let natsConn: NatsConnection;
  let vault: VaultClientService;
  let connectors: IntegrationConnectorsService;
  let subscriptions: WebhookSubscriptionsService;
  let deliveries: WebhookDeliveriesService;
  let fanout: WebhookFanoutService;
  let dispatcher: WebhookDeliveryDispatcherService;
  let syncJobs: SyncJobsService;
  let syncJobsNatsClient: IntegrationHubNatsClientService;
  let receiverServer: Server;
  let receiverBaseUrl: string;
  const receivedOkRequests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const tenantId = process.env.ACME_DEMO_TENANT_ID ?? '23852ab6-7765-4d5c-9c4c-a21d79de31e9';
  const createdConnectorIds: string[] = [];
  const createdSubscriptionIds: string[] = [];

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
    natsConn = await connectNats({ servers: process.env.NATS_URL ?? 'nats://localhost:4222', timeout: 2000 });

    vault = new VaultClientService({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
      kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
    });
    connectors = new IntegrationConnectorsService(appDataSource, vault, new OAuthTokenExchangeService(), { record: async () => undefined } as any);
    subscriptions = new WebhookSubscriptionsService(appDataSource, vault);
    deliveries = new WebhookDeliveriesService(appDataSource, migratorPool);
    fanout = new WebhookFanoutService(appDataSource, deliveries);
    dispatcher = new WebhookDeliveryDispatcherService(deliveries, subscriptions, vault, new MetricsService());
    syncJobsNatsClient = new IntegrationHubNatsClientService();
    syncJobs = new SyncJobsService(appDataSource, syncJobsNatsClient, fanout);

    receiverServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/webhook-ok') {
          receivedOkRequests.push({ headers: req.headers, body });
          res.statusCode = 200;
          res.end('ok');
          return;
        }
        if (req.url === '/webhook-fail') {
          res.statusCode = 500;
          res.end('simulated receiver failure');
          return;
        }
        res.statusCode = 404;
        res.end('unknown path');
      });
    });
    await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const address = receiverServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake receiver server');
    receiverBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await natsConn.drain();
    await syncJobsNatsClient.onModuleDestroy();

    if (createdConnectorIds.length) {
      await migratorPool.query(`DELETE FROM integration_hub.webhook_delivery WHERE webhook_subscription_id = ANY($1)`, [
        createdSubscriptionIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.webhook_subscription WHERE id = ANY($1)`, [
        createdSubscriptionIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.sync_job WHERE connector_id = ANY($1)`, [
        createdConnectorIds,
      ]);
      await migratorPool.query(`DELETE FROM integration_hub.integration_connector WHERE id = ANY($1)`, [
        createdConnectorIds,
      ]);
    }
    await migratorPool.end();
    await appDataSource.destroy();
  });

  it('a real SyncJob completion publishes to a real NATS subject and fans out a real HMAC-signed delivery to a real receiver', async () => {
    const { connector } = await connectors.create(tenantId, {
      connectorType: ConnectorType.HRIS,
      provider: 'Workday',
      credentials: { accessToken: 'unused-for-this-test' },
    });
    createdConnectorIds.push(connector.id);

    const { subscription, secret } = await subscriptions.create(tenantId, {
      eventTypes: ['sync_job.completed'],
      targetUrl: `${receiverBaseUrl}/webhook-ok`,
    });
    createdSubscriptionIds.push(subscription.id);
    expect(subscription.status).toBe(WebhookSubscriptionStatus.ACTIVE);

    const natsMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NATS message did not arrive within 5000ms')), 5000);
      void (async () => {
        const sub = natsConn.subscribe('agno.integration_hub.sync_job.completed.v1', { max: 1 });
        for await (const msg of sub) {
          clearTimeout(timer);
          resolve(JSON.parse(codec.decode(msg.data)) as Record<string, unknown>);
          break;
        }
      })();
    });

    const job = await syncJobs.enqueue(tenantId, connector.id, SyncType.INCREMENTAL);
    await syncJobs.complete(tenantId, job.id, {
      status: SyncJobStatus.COMPLETED,
      recordsProcessed: 3,
      recordsFailed: 0,
    });

    // Real proof #1: the NATS publish actually happened and landed on the
    // real subject, not just that `natsClient.publish` was called.
    const received = await natsMessage;
    expect(received).toMatchObject({ syncJobId: job.id, tenantId, connectorId: connector.id, status: 'completed' });

    await dispatcher.tick();

    // Real proof #2: the receiver actually got a request, and its own
    // independently-recomputed HMAC (using the secret returned exactly
    // once at creation, not anything read back from this service) matches
    // - proof the dispatcher signs correctly, not just that it POSTs.
    const delivered = await waitUntil(() => (receivedOkRequests.length > 0 ? receivedOkRequests[0] : undefined));
    const sigHeader = delivered.headers['x-agno-webhook-signature'] as string;
    const [tPart, vPart] = sigHeader.split(',');
    const timestamp = tPart.replace('t=', '');
    const expectedSignature = createHmac('sha256', secret).update(`${timestamp}.${delivered.body}`).digest('hex');
    expect(vPart).toBe(`v1=${expectedSignature}`);
    expect(delivered.headers['x-agno-webhook-event-type']).toBe('sync_job.completed');

    const deliveryRows = await deliveries.findAllForSubscription(tenantId, subscription.id, 10);
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0].deliveredAt).not.toBeNull();
    expect(deliveryRows[0].responseStatusCode).toBe(200);
  });

  it('auto-disables a subscription after sustained delivery failures, and a disabled subscription stops receiving new fan-out', async () => {
    const { subscription: failingSubscription } = await subscriptions.create(tenantId, {
      eventTypes: ['sync_job.completed'],
      targetUrl: `${receiverBaseUrl}/webhook-fail`,
    });
    createdSubscriptionIds.push(failingSubscription.id);

    // `DISABLED_THRESHOLD` distinct deliveries, each a real fan-out call
    // (the same call `SyncJobsService.complete()` makes) rather than
    // driving it through `DISABLED_THRESHOLD` real `SyncJob` completions -
    // this test's target is the auto-disable escalation itself, already
    // proven to be reachable from a real completion by the test above.
    for (let i = 0; i < DISABLED_THRESHOLD; i++) {
      await fanout.fanOut(tenantId, 'sync_job.completed', { attempt: i });
    }
    const beforeDispatch = await deliveries.findAllForSubscription(
      tenantId,
      failingSubscription.id,
      DISABLED_THRESHOLD + 5,
    );
    expect(beforeDispatch).toHaveLength(DISABLED_THRESHOLD);

    await dispatcher.tick();

    const afterFirstTick = await subscriptions.findByIdForTenant(tenantId, failingSubscription.id);
    expect(afterFirstTick.consecutiveFailureCount).toBeGreaterThanOrEqual(FAILING_THRESHOLD);
    expect(afterFirstTick.status).toBe(WebhookSubscriptionStatus.DISABLED);

    // A disabled subscription is excluded from future fan-out entirely
    // (`WebhookFanoutService`'s own `status != disabled` filter) - real
    // proof: one more fan-out call produces no new delivery row.
    await fanout.fanOut(tenantId, 'sync_job.completed', { attempt: 'after-disable' });
    const afterDisableFanout = await deliveries.findAllForSubscription(
      tenantId,
      failingSubscription.id,
      DISABLED_THRESHOLD + 5,
    );
    expect(afterDisableFanout).toHaveLength(DISABLED_THRESHOLD);
  }, 30000);

  it('testWebhook enqueues a real synthetic delivery through the same dispatcher path and it is genuinely delivered', async () => {
    const { subscription } = await subscriptions.create(tenantId, {
      eventTypes: ['sync_job.completed'],
      targetUrl: `${receiverBaseUrl}/webhook-ok`,
    });
    createdSubscriptionIds.push(subscription.id);

    await deliveries.enqueue(tenantId, subscription.id, 'webhook.test', {
      message: 'This is a test delivery from Agno WFM Integration Hub.',
      triggeredAt: new Date().toISOString(),
    });
    await dispatcher.tick();

    const rows = await deliveries.findAllForSubscription(tenantId, subscription.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('webhook.test');
    expect(rows[0].deliveredAt).not.toBeNull();
  });
});
