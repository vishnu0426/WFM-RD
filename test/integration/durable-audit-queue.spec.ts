import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant, User } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../src/modules/audit/repositories/audit-log.repository';
import { PendingAuditEventsRepository } from '../../src/modules/audit/repositories/pending-audit-events.repository';
import { AuditEventBatcherService } from '../../src/modules/audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../src/modules/audit/entities/audit-actor-type.enum';

dotenv.config();

/**
 * ADR-0042: `core.pending_audit_events` is what closes the "no durable
 * queue behind NATS" gap - `AuditEventBatcherService.enqueue` used to push
 * onto a plain in-memory array, so a process crash between `enqueue` and
 * the next flush tick lost the event outright. This suite proves the
 * replacement is actually durable: a row inserted by one
 * `PendingAuditEventsRepository` instance is still there - and gets
 * correctly processed - by a *second*, independently-constructed
 * `AuditEventBatcherService` instance, simulating "the process that
 * enqueued this event died, and a replacement process picked it up."
 */
describe('Phase 5 follow-up - durable audit event queue (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditLogRepository: AuditLogRepository;
  let pendingEventsRepository: PendingAuditEventsRepository;

  let tenantId: string;
  let userId: string;

  const natsClientStub = { publish: jest.fn().mockRejectedValue(new Error('no broker in this test env')) };

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
    auditLogRepository = new AuditLogRepository(appDataSource, tenantContext);
    pendingEventsRepository = new PendingAuditEventsRepository(appDataSource);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Durable Audit Queue Test Tenant ${uuidv4()}`,
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
        email: `durable-audit-queue-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    userId = user.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  const countPendingRows = async (): Promise<number> => {
    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows = await migratorDataSource.query(
      'SELECT count(*)::int AS count FROM core.pending_audit_events WHERE tenant_id = $1',
      [tenantId],
    );
    return rows[0].count as number;
  };

  it('enqueue durably inserts a row into core.pending_audit_events', async () => {
    await pendingEventsRepository.enqueue({
      tenantId,
      actorId: userId,
      actorType: AuditActorType.USER,
      action: 'durable_queue.test.enqueued',
      resourceType: 'test_resource',
      resourceId: null,
      beforeState: null,
      afterState: { step: 'enqueue-only' },
      aiRationale: null,
    });

    const count = await countPendingRows();
    expect(count).toBeGreaterThan(0);
  });

  it('a row enqueued by one instance is found and processed by a second, independently-constructed batcher (simulated process restart)', async () => {
    const beforeCount = await countPendingRows();

    // "process A" - enqueues durably, then (simulated) crashes before flushing.
    const repositoryInProcessA = new PendingAuditEventsRepository(appDataSource);
    await repositoryInProcessA.enqueue({
      tenantId,
      actorId: userId,
      actorType: AuditActorType.USER,
      action: 'durable_queue.test.survives_restart',
      resourceType: 'test_resource',
      resourceId: null,
      beforeState: null,
      afterState: { step: 'process-a' },
      aiRationale: null,
    });
    expect(await countPendingRows()).toBe(beforeCount + 1);

    // "process B" - a fresh instance, sharing nothing with process A except the database.
    const repositoryInProcessB = new PendingAuditEventsRepository(appDataSource);
    const batcherInProcessB = new AuditEventBatcherService(
      auditLogRepository,
      tenantContext,
      natsClientStub as never,
      repositoryInProcessB,
    );

    await batcherInProcessB.flush();

    // Processed and removed from the durable queue - not lost, not stuck.
    expect(await countPendingRows()).toBe(beforeCount);

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const auditRows = await migratorDataSource.query(
      "SELECT action FROM core.audit_log WHERE tenant_id = $1 AND action = 'durable_queue.test.survives_restart'",
      [tenantId],
    );
    expect(auditRows.length).toBe(1);
  });

  it('a durably-queued event still gets processed after a transient audit_log failure is retried', async () => {
    const flakyAuditLogRepository = {
      record: jest
        .fn()
        .mockRejectedValueOnce(new Error('simulated transient failure'))
        .mockImplementationOnce((entry: Parameters<AuditLogRepository['record']>[0]) =>
          auditLogRepository.record(entry),
        ),
    };
    const batcher = new AuditEventBatcherService(
      flakyAuditLogRepository as never,
      tenantContext,
      natsClientStub as never,
      pendingEventsRepository,
    );

    await pendingEventsRepository.enqueue({
      tenantId,
      actorId: userId,
      actorType: AuditActorType.USER,
      action: 'durable_queue.test.retried',
      resourceType: 'test_resource',
      resourceId: null,
      beforeState: null,
      afterState: null,
      aiRationale: null,
    });

    await batcher.flush(); // attempt 1 fails - row stays, attempts incremented.
    expect(flakyAuditLogRepository.record).toHaveBeenCalledTimes(1);

    await batcher.flush(); // attempt 2 succeeds via the real repository - row is removed.
    expect(flakyAuditLogRepository.record).toHaveBeenCalledTimes(2);

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const auditRows = await migratorDataSource.query(
      "SELECT action FROM core.audit_log WHERE tenant_id = $1 AND action = 'durable_queue.test.retried'",
      [tenantId],
    );
    expect(auditRows.length).toBe(1);
  });
});
