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
import { AuditActorType } from '../../src/modules/audit/entities/audit-actor-type.enum';
import { PoliciesRepository } from '../../src/modules/policy/repositories/policies.repository';
import { PolicyType } from '../../src/modules/policy/entities/policy-type.enum';
import { SUBJECTS } from '../../src/modules/core-eventing/subjects';

dotenv.config();

/**
 * Phase 5 (§4, ADR-0039): the transactional outbox for `core.outbox_events`
 * - proves `AuditLogRepository.record` and `PoliciesRepository.createLineage`/
 * `.supersede` each write their domain row *and* an outbox row in one
 * atomic transaction, with the correct subject/payload. Actual NATS
 * delivery (`CoreOutboxPublisherService`'s drain loop) is exercised
 * against a mocked `NatsClientService` elsewhere (unit tests) and is not
 * re-verified against a live broker here - same posture ADR-0019 already
 * documented for Module 02's identical pattern.
 */
describe('Phase 5 - core.outbox_events transactional outbox (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditLogRepository: AuditLogRepository;
  let policiesRepository: PoliciesRepository;

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
    auditLogRepository = new AuditLogRepository(appDataSource, tenantContext);
    policiesRepository = new PoliciesRepository(appDataSource, tenantContext);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Outbox Test Tenant ${uuidv4()}`,
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
        email: `outbox-${uuidv4()}@example.com`,
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

  const findOutboxRow = async (subject: string, predicate: (payload: Record<string, unknown>) => boolean) => {
    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows: { payload: Record<string, unknown> }[] = await migratorDataSource.query(
      'SELECT payload FROM core.outbox_events WHERE tenant_id = $1 AND subject = $2 ORDER BY created_at DESC',
      [tenantId, subject],
    );
    return rows.map((r) => r.payload).find(predicate);
  };

  it('AuditLogRepository.record writes an AuditEvent outbox row in the same transaction', async () => {
    const entry = await tenantContext.run({ tenantId }, () =>
      auditLogRepository.record({
        tenantId,
        actorId: userId,
        actorType: AuditActorType.USER,
        action: 'outbox.test.action',
        resourceType: 'test_resource',
        resourceId: null,
        beforeState: null,
        afterState: { foo: 'bar' },
        aiRationale: null,
      }),
    );

    const outboxPayload = await findOutboxRow(SUBJECTS.AUDIT_CREATED, (payload) => payload.auditLogId === entry.id);
    expect(outboxPayload).toBeDefined();
    expect(outboxPayload?.action).toBe('outbox.test.action');
    expect(outboxPayload?.tenantId).toBe(tenantId);
  });

  it('PoliciesRepository.createLineage writes a PolicyChanged outbox row in the same transaction', async () => {
    const policy = await tenantContext.run({ tenantId }, () =>
      policiesRepository.createLineage({
        policyType: PolicyType.OVERTIME_RULE,
        orgUnitId: null,
        definition: { dailyThresholdHours: 8 },
        effectiveFrom: new Date(),
      }),
    );

    const outboxPayload = await findOutboxRow(SUBJECTS.POLICY_CHANGED, (payload) => payload.policyId === policy.id);
    expect(outboxPayload).toBeDefined();
    expect(outboxPayload?.version).toBe(1);
    expect(outboxPayload?.policyGroupId).toBe(policy.policyGroupId);
  });

  it('PoliciesRepository.supersede writes a second PolicyChanged outbox row for the new version', async () => {
    const v1 = await tenantContext.run({ tenantId }, () =>
      policiesRepository.createLineage({
        policyType: PolicyType.BREAK_RULE,
        orgUnitId: null,
        definition: { minMinutes: 30 },
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      }),
    );

    const v2 = await tenantContext.run({ tenantId }, () =>
      policiesRepository.supersede(v1.policyGroupId, {
        policyType: PolicyType.BREAK_RULE,
        orgUnitId: null,
        definition: { minMinutes: 45 },
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      }),
    );

    const outboxPayload = await findOutboxRow(SUBJECTS.POLICY_CHANGED, (payload) => payload.policyId === v2.id);
    expect(outboxPayload).toBeDefined();
    expect(outboxPayload?.version).toBe(2);
    expect(outboxPayload?.policyGroupId).toBe(v1.policyGroupId);
  });

  it('a rejected ai_agent audit write (no ai_rationale) writes neither the audit_log row nor an outbox row', async () => {
    const beforeCount = await tenantContext.run({ tenantId }, async () => {
      await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
      const rows = await migratorDataSource.query(
        'SELECT count(*)::int AS count FROM core.outbox_events WHERE tenant_id = $1 AND subject = $2',
        [tenantId, SUBJECTS.AUDIT_CREATED],
      );
      return rows[0].count as number;
    });

    await expect(
      tenantContext.run({ tenantId }, () =>
        auditLogRepository.record({
          tenantId,
          actorId: null,
          actorType: AuditActorType.AI_AGENT,
          action: 'outbox.test.ai_action',
          resourceType: 'test_resource',
          resourceId: null,
          beforeState: null,
          afterState: null,
          aiRationale: null,
        }),
      ),
    ).rejects.toThrow();

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const rows = await migratorDataSource.query(
      'SELECT count(*)::int AS count FROM core.outbox_events WHERE tenant_id = $1 AND subject = $2',
      [tenantId, SUBJECTS.AUDIT_CREATED],
    );
    expect(rows[0].count as number).toBe(beforeCount);
  });
});
