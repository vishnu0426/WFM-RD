import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant, User } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { NotificationPreferencesRepository } from '../../src/modules/notification/repositories/notification-preferences.repository';
import { NotificationDeliveryRepository } from '../../src/modules/notification/repositories/notification-delivery.repository';
import { NotificationRulesRepository } from '../../src/modules/notification/repositories/notification-rules.repository';
import { NotificationService } from '../../src/modules/notification/services/notification.service';
import { NotificationDeliveryDispatcherService } from '../../src/modules/notification/services/notification-delivery-dispatcher.service';
import { LoggingChannelAdapter } from '../../src/modules/notification/channels/logging-channel-adapter';
import { NotificationChannel } from '../../src/modules/notification/entities/notification-channel.enum';
import { NotificationPreference } from '../../src/modules/notification/entities/notification-preference.entity';
import { NotificationDeliveryStatus } from '../../src/modules/notification/entities/notification-delivery.entity';

dotenv.config();

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): proves the real
 * enqueue -> claim -> send -> mark-sent path against live Postgres,
 * including RLS - unit tests (test/unit/notification/*) already cover the
 * dispatcher/service logic in isolation with mocked repositories; this is
 * the "does the actual SQL/RLS/entity mapping work" layer, same posture as
 * `core-eventing-outbox.spec.ts`. Deliberately does NOT boot the full
 * `AppModule` (GraphQL/gRPC/SSO et al.) - same lighter direct-DataSource
 * pattern nearly every other integration test in this file already uses.
 */
describe('GAP-05 - notification delivery engine (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let preferencesRepository: NotificationPreferencesRepository;
  let deliveryRepository: NotificationDeliveryRepository;
  let rulesRepository: NotificationRulesRepository;
  let notificationService: NotificationService;
  let dispatcher: NotificationDeliveryDispatcherService;

  let tenantId: string;
  let userId: string;

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
    preferencesRepository = new NotificationPreferencesRepository(appDataSource, tenantContext);
    deliveryRepository = new NotificationDeliveryRepository(appDataSource);
    rulesRepository = new NotificationRulesRepository(appDataSource, tenantContext);
    notificationService = new NotificationService(tenantContext, preferencesRepository, deliveryRepository, rulesRepository);
    dispatcher = new NotificationDeliveryDispatcherService(deliveryRepository, [
      new LoggingChannelAdapter(NotificationChannel.EMAIL),
      new LoggingChannelAdapter(NotificationChannel.SMS),
      new LoggingChannelAdapter(NotificationChannel.PUSH),
      new LoggingChannelAdapter(NotificationChannel.IN_APP),
    ] as never);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Notification Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const user = await migratorDataSource.getRepository(User).save(
      migratorDataSource.getRepository(User).create({
        tenantId,
        email: `notification-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    userId = user.id;

    await migratorDataSource.getRepository(NotificationPreference).save(
      migratorDataSource.getRepository(NotificationPreference).create({
        tenantId,
        userId,
        channel: NotificationChannel.EMAIL,
        eventType: 'gap05_test_event',
        enabled: true,
      }),
    );
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('enqueue writes a real notification_delivery row scoped to this tenant/user', async () => {
    const count = await tenantContext.run({ tenantId }, () =>
      notificationService.enqueue(userId, 'gap05_test_event', { detail: 'integration-test-1' }),
    );
    expect(count).toBe(1);

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows: { status: string; channel: string; payload: Record<string, unknown> }[] =
      await migratorDataSource.query(
        'SELECT status, channel, payload FROM core.notification_delivery WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
        [tenantId, userId],
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(NotificationDeliveryStatus.PENDING);
    expect(rows[0].channel).toBe(NotificationChannel.EMAIL);
    expect(rows[0].payload).toEqual({ detail: 'integration-test-1' });
  });

  it('the dispatcher claims the real row, sends via the adapter, and marks it sent', async () => {
    await tenantContext.run({ tenantId }, () =>
      notificationService.enqueue(userId, 'gap05_test_event', { detail: 'integration-test-2' }),
    );

    await dispatcher.tick();

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows: { status: string; sent_at: Date | null }[] = await migratorDataSource.query(
      `SELECT status, sent_at FROM core.notification_delivery
       WHERE tenant_id = $1 AND user_id = $2 AND payload->>'detail' = $3`,
      [tenantId, userId, 'integration-test-2'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(NotificationDeliveryStatus.SENT);
    expect(rows[0].sent_at).not.toBeNull();
  });

  it("RLS: agno_app cannot read another tenant's notification_delivery rows through the tenant-scoped connection", async () => {
    const otherTenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Notification RLS Other Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );

    await appDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', otherTenant.id]);
    await appDataSource.query('SELECT set_config($1, $2, false)', ['app.is_platform_admin', 'false']);
    const rows = await appDataSource.query('SELECT id FROM core.notification_delivery WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
