import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { WebhookSubscriptionsRepository } from '../../src/modules/webhook/repositories/webhook-subscriptions.repository';
import { WebhookDeliveriesRepository } from '../../src/modules/webhook/repositories/webhook-deliveries.repository';
import { WebhookFanoutService } from '../../src/modules/webhook/services/webhook-fanout.service';
import { SUBJECTS } from '../../src/modules/core-eventing/subjects';

dotenv.config();

/**
 * Phase 6 (ADR-0046): proves `WebhookFanoutService.fanOut` (called from
 * `CoreOutboxPublisherService.drain` after a successful NATS publish)
 * correctly enqueues a durable `core.webhook_deliveries` row for every
 * *active* subscription whose `subscribedSubjects` includes the event's
 * subject, and none for a non-matching subject or an inactive subscription
 * - against real Postgres, real RLS.
 */
describe('Phase 6 - webhook fan-out (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let subscriptionsRepository: WebhookSubscriptionsRepository;
  let deliveriesRepository: WebhookDeliveriesRepository;
  let fanoutService: WebhookFanoutService;

  let tenantId: string;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await appDataSource.initialize();

    migratorDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      entities,
      synchronize: false,
    });
    await migratorDataSource.initialize();

    tenantContext = new TenantContextService();
    subscriptionsRepository = new WebhookSubscriptionsRepository(appDataSource, tenantContext);
    deliveriesRepository = new WebhookDeliveriesRepository(appDataSource);
    fanoutService = new WebhookFanoutService(tenantContext, subscriptionsRepository, deliveriesRepository);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Webhook Fanout Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  const countDeliveries = async (subscriptionId: string): Promise<number> => {
    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows = await migratorDataSource.query(
      'SELECT count(*)::int AS count FROM core.webhook_deliveries WHERE subscription_id = $1',
      [subscriptionId],
    );
    return rows[0].count as number;
  };

  it('enqueues a delivery for an active subscription whose subscribedSubjects includes the event subject', async () => {
    const subscription = await tenantContext.run({ tenantId }, () =>
      subscriptionsRepository.save({
        url: 'https://example.com/webhook-a',
        description: null,
        secret: 'sub-a-secret',
        subscribedSubjects: [SUBJECTS.AUDIT_CREATED],
        isActive: true,
      } as never),
    );

    await fanoutService.fanOut(tenantId, SUBJECTS.AUDIT_CREATED, { auditLogId: uuidv4() });

    expect(await countDeliveries(subscription.id)).toBe(1);
  });

  it('does not enqueue a delivery when the subject is not in subscribedSubjects', async () => {
    const subscription = await tenantContext.run({ tenantId }, () =>
      subscriptionsRepository.save({
        url: 'https://example.com/webhook-b',
        description: null,
        secret: 'sub-b-secret',
        subscribedSubjects: [SUBJECTS.POLICY_CHANGED],
        isActive: true,
      } as never),
    );

    await fanoutService.fanOut(tenantId, SUBJECTS.AUDIT_CREATED, { auditLogId: uuidv4() });

    expect(await countDeliveries(subscription.id)).toBe(0);
  });

  it('does not enqueue a delivery for an inactive subscription', async () => {
    const subscription = await tenantContext.run({ tenantId }, () =>
      subscriptionsRepository.save({
        url: 'https://example.com/webhook-c',
        description: null,
        secret: 'sub-c-secret',
        subscribedSubjects: [SUBJECTS.AUDIT_CREATED],
        isActive: false,
      } as never),
    );

    await fanoutService.fanOut(tenantId, SUBJECTS.AUDIT_CREATED, { auditLogId: uuidv4() });

    expect(await countDeliveries(subscription.id)).toBe(0);
  });

  it('a pending delivery row is visible to the cross-tenant dispatcher batch read', async () => {
    const subscription = await tenantContext.run({ tenantId }, () =>
      subscriptionsRepository.save({
        url: 'https://example.com/webhook-d',
        description: null,
        secret: 'sub-d-secret',
        subscribedSubjects: [SUBJECTS.AUDIT_CREATED],
        isActive: true,
      } as never),
    );
    await fanoutService.fanOut(tenantId, SUBJECTS.AUDIT_CREATED, { auditLogId: uuidv4() });

    const batch = await deliveriesRepository.findPendingBatch(500);
    expect(batch.some((d) => d.subscriptionId === subscription.id)).toBe(true);
  });
});
