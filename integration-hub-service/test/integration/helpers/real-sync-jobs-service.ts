import { DataSource } from 'typeorm';
import { Pool } from 'pg';
import { SyncJobsService } from '../../../src/sync/sync-jobs.service';
import { IntegrationHubNatsClientService } from '../../../src/webhooks/nats/integration-hub-nats-client.service';
import { WebhookDeliveriesService } from '../../../src/webhooks/webhook-deliveries.service';
import { WebhookFanoutService } from '../../../src/webhooks/webhook-fanout.service';

const createdNatsClients: IntegrationHubNatsClientService[] = [];
const createdMigratorPools: Pool[] = [];

/**
 * §7 Phase 7 gave `SyncJobsService` two new real dependencies
 * (`IntegrationHubNatsClientService`, `WebhookFanoutService`, itself
 * needing `WebhookDeliveriesService` and a migrator `Pool`) - every
 * integration test in this suite that needs a real `SyncJobsService`
 * needs this same construction, so it lives here once instead of as 11
 * near-identical copies (this suite's own "real infra, not mocks" posture
 * means these can't be stubbed away either).
 *
 * Every client this creates is tracked and must be closed via
 * `closeRealSyncJobsServiceConnections()` in the caller's own `afterAll` -
 * a real, once-encountered bug (not hypothetical): an undrained NATS
 * connection left the whole suite's Jest process alive long after every
 * test had actually finished, the identical class of hang
 * `genesys-cloud-adapter.spec.ts`'s own WebSocket cleanup bug was (its own
 * design doc), just on a different transport.
 */
export function makeRealSyncJobsService(dataSource: DataSource): SyncJobsService {
  const migratorPool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
    password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
    database: process.env.DB_DATABASE ?? 'agno_wfm',
    max: 2,
  });
  const natsClient = new IntegrationHubNatsClientService();
  const webhookDeliveries = new WebhookDeliveriesService(dataSource, migratorPool);
  const webhookFanout = new WebhookFanoutService(dataSource, webhookDeliveries);

  createdMigratorPools.push(migratorPool);
  createdNatsClients.push(natsClient);

  return new SyncJobsService(dataSource, natsClient, webhookFanout);
}

export async function closeRealSyncJobsServiceConnections(): Promise<void> {
  for (const client of createdNatsClients.splice(0)) {
    await client.onModuleDestroy();
  }
  for (const pool of createdMigratorPools.splice(0)) {
    await pool.end();
  }
}
