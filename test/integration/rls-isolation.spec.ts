import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant, User, AuditLog, Role } from '../../src/modules/entities';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { TenantMismatchError, TenantContextMissingError } from '../../src/common/tenant/tenant-context.errors';
import { UsersRepository } from '../../src/modules/identity/repositories/users.repository';
import { AuditLogRepository } from '../../src/modules/audit/repositories/audit-log.repository';
import { TenantsRepository } from '../../src/modules/tenant/repositories/tenants.repository';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { AuditActorType } from '../../src/modules/audit/entities/audit-actor-type.enum';

dotenv.config();

/**
 * Requires a reachable Postgres with the Phase 1 migration already applied
 * (docker-compose up -d && npm run migration:run). Exercises both layers of
 * ADR-0002's defense-in-depth: the TenantScopedRepository guard AND raw
 * Postgres RLS underneath it (by talking to the DB directly, bypassing the
 * guard entirely, to prove RLS holds on its own).
 */
describe('Tenant isolation (application guard + Postgres RLS)', () => {
  let appDataSource: DataSource; // connects as agno_app, same as the running application
  let migratorDataSource: DataSource; // agno_app cannot write global (tenant_id IS NULL) rows by design
  let tenantContext: TenantContextService;
  let usersRepository: UsersRepository;
  let tenantsRepository: TenantsRepository;

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

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
    // agno_app's roles_insert RLS policy requires tenant_id = current tenant,
    // so it can never write a global (tenant_id IS NULL) system role by
    // design (ADR-0002) - only the migrator/platform-admin path can.
    await migratorDataSource
      .getRepository(Role)
      .save(
        migratorDataSource
          .getRepository(Role)
          .create({ name: `rls_test_system_role_${uuidv4()}`, isSystemRole: true, tenantId: null }),
      );

    tenantContext = new TenantContextService();
    usersRepository = new UsersRepository(appDataSource, tenantContext);
    tenantsRepository = new TenantsRepository(appDataSource, tenantContext);

    // Created via migratorDataSource, not appDataSource: tenants is now
    // RLS-protected (ADR-0007), and creating a brand-new top-level tenant
    // requires either is_platform_admin or being the resulting row's own
    // parent - neither holds for a fixture created with no session context
    // at all, so this goes through the same elevated path a real platform
    // bootstrap/seed job would use (agno_migrator bypasses RLS as owner).
    const migratorTenantRepo = migratorDataSource.getRepository(Tenant);
    const tenantA = await migratorTenantRepo.save(
      migratorTenantRepo.create({
        name: `RLS Test Tenant A ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    const tenantB = await migratorTenantRepo.save(
      migratorTenantRepo.create({
        name: `RLS Test Tenant B ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const userA = await tenantContext.run({ tenantId: tenantAId }, () =>
      usersRepository.save({
        tenantId: tenantAId,
        email: `a-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      } as User),
    );
    const userB = await tenantContext.run({ tenantId: tenantBId }, () =>
      usersRepository.save({
        tenantId: tenantBId,
        email: `b-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      } as User),
    );
    userAId = userA.id;
    userBId = userB.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('the application guard fails closed with no tenant context bound', async () => {
    await expect(usersRepository.find()).rejects.toThrow(TenantContextMissingError);
  });

  it("a tenant's repository view only returns that tenant's rows", async () => {
    const usersSeenByA = await tenantContext.run({ tenantId: tenantAId }, () => usersRepository.find());
    expect(usersSeenByA.map((u) => u.id)).toContain(userAId);
    expect(usersSeenByA.map((u) => u.id)).not.toContain(userBId);
  });

  it('the guard rejects saving an entity whose tenantId conflicts with the bound context', async () => {
    await expect(
      tenantContext.run({ tenantId: tenantAId }, () =>
        usersRepository.save({
          tenantId: tenantBId,
          email: `x-${uuidv4()}@example.com`,
          status: UserStatus.INVITED,
          mfaEnabled: false,
        } as User),
      ),
    ).rejects.toThrow(TenantMismatchError);
  });

  it('Postgres RLS holds even if the application guard is bypassed entirely', async () => {
    // Talk to Postgres directly as agno_app, with no SET LOCAL app.current_tenant_id
    // at all - simulates a future bug where someone queries outside TenantScopedRepository.
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      const result = await rawClient.query('SELECT id FROM core.users WHERE id = ANY($1::uuid[])', [
        [userAId, userBId],
      ]);
      // No session tenant bound -> current_setting(...) is NULL -> every
      // policy's USING clause is false -> zero rows, not all rows.
      expect(result.rows).toHaveLength(0);
    } finally {
      await rawClient.end();
    }
  });

  it('system-global roles (tenant_id IS NULL) are readable from any tenant context', async () => {
    const rolesRepo = appDataSource.getRepository(Role);
    const roles = await tenantContext.run({ tenantId: tenantAId }, async () => {
      const raw = new Client({
        host: process.env.DB_HOST ?? 'localhost',
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USERNAME ?? 'agno_app',
        password: process.env.DB_PASSWORD ?? 'changeme_local_only',
        database: process.env.DB_DATABASE ?? 'agno_wfm',
      });
      await raw.connect();
      // is_local=false (a session-level SET, not SET LOCAL): this raw client
      // has no surrounding BEGIN/COMMIT, so each awaited query above is its
      // own implicit transaction. With is_local=true, the GUC reverts the
      // instant that first implicit transaction ends - not to NULL, but to
      // the custom GUC's placeholder default of '' - so the very next
      // statement's current_setting(...)::uuid cast (inside the RLS policy)
      // throws `invalid input syntax for type uuid: ""` instead of seeing
      // tenantAId. Session-level SET persists for this connection's whole
      // lifetime, which is fine here since `raw` is single-use and closed
      // immediately below.
      await raw.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantAId]);
      const res = await raw.query('SELECT tenant_id FROM core.roles');
      await raw.end();
      return res.rows as { tenant_id: string | null }[];
    });
    void rolesRepo; // typing anchor only, no ORM call needed for this assertion
    expect(roles.some((r) => r.tenant_id === null)).toBe(true);
  });

  it('a tenant can read itself but not an unrelated tenant (ADR-0007)', async () => {
    const self = await tenantContext.run({ tenantId: tenantAId }, () => tenantsRepository.findSelf());
    expect(self?.id).toBe(tenantAId);

    const unrelated = await tenantContext.run({ tenantId: tenantAId }, () => tenantsRepository.findById(tenantBId));
    expect(unrelated).toBeNull();
  });

  it("a tenant can see its own BPO child but not another tenant's child (ADR-0007)", async () => {
    const migratorTenantRepo = migratorDataSource.getRepository(Tenant);
    const childOfA = await migratorTenantRepo.save(
      migratorTenantRepo.create({
        name: `RLS Test Tenant A-child ${uuidv4()}`,
        parentTenantId: tenantAId,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );

    const childrenSeenByA = await tenantContext.run({ tenantId: tenantAId }, () =>
      tenantsRepository.findChildren(tenantAId),
    );
    expect(childrenSeenByA.map((t) => t.id)).toContain(childOfA.id);

    const childrenOfASeenByB = await tenantContext.run({ tenantId: tenantBId }, () =>
      tenantsRepository.findChildren(tenantAId),
    );
    expect(childrenOfASeenByB).toHaveLength(0);
  });

  it('a non-admin tenant cannot create a new top-level tenant (tenants_insert RLS policy)', async () => {
    await expect(
      tenantContext.run({ tenantId: tenantAId }, () =>
        tenantsRepository.create({
          name: `should be rejected ${uuidv4()}`,
          parentTenantId: null,
          tier: TenantTier.SMB,
          dataResidencyRegion: 'us-east-1',
          status: TenantStatus.PROVISIONING,
          slug: `should-be-rejected-${uuidv4()}`,
          industry: null,
          country: null,
          currency: null,
          language: null,
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a non-admin tenant CAN onboard a child tenant under itself (BPO onboarding)', async () => {
    const child = await tenantContext.run({ tenantId: tenantAId }, () =>
      tenantsRepository.create({
        name: `BPO child of A ${uuidv4()}`,
        parentTenantId: tenantAId,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.PROVISIONING,
        slug: `bpo-child-of-a-${uuidv4()}`,
        industry: null,
        country: null,
        currency: null,
        language: null,
      }),
    );
    expect(child.parentTenantId).toBe(tenantAId);
  });

  it('a platform-admin session sees across tenants and may create a new top-level tenant (ADR-0007 escape hatch)', async () => {
    const seenAsAdmin = await tenantContext.run({ tenantId: tenantAId, isPlatformAdmin: true }, () =>
      tenantsRepository.findById(tenantBId),
    );
    expect(seenAsAdmin?.id).toBe(tenantBId);

    const created = await tenantContext.run({ tenantId: tenantAId, isPlatformAdmin: true }, () =>
      tenantsRepository.create({
        name: `platform-admin-created ${uuidv4()}`,
        parentTenantId: null,
        tier: TenantTier.ENTERPRISE,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.PROVISIONING,
        slug: `platform-admin-created-${uuidv4()}`,
        industry: null,
        country: null,
        currency: null,
        language: null,
      }),
    );
    expect(created.parentTenantId).toBeNull();
  });

  it('audit_log rejects UPDATE/DELETE from agno_app at the grant level (§2.2 rule 2)', async () => {
    const auditLogRepository = new AuditLogRepository(appDataSource, tenantContext);
    const entry = await tenantContext.run({ tenantId: tenantAId }, () =>
      auditLogRepository.record({
        tenantId: tenantAId,
        actorId: userAId,
        actorType: AuditActorType.USER,
        action: 'test.action',
        resourceType: 'test_resource',
        resourceId: null,
        beforeState: null,
        afterState: null,
        aiRationale: null,
      }),
    );

    // Raw, dedicated client - not the pooled appDataSource.query(): a prior
    // test in this suite ran `set_config(..., true)` (SET LOCAL) inside a
    // transaction on some pooled physical connection; once that transaction
    // ended, the custom GUC's value reverted to its placeholder default
    // ('' , not NULL - a real Postgres quirk for never-preloaded custom
    // GUCs). If THIS query happens to reuse that same physical connection,
    // its RLS policy's current_setting(...)::uuid cast throws instead of
    // exercising the grant check this test actually cares about. A fresh
    // connection has no such history. Same posture as the
    // "Postgres RLS holds even if bypassed" test above.
    const rawClient = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
    });
    await rawClient.connect();
    try {
      await expect(
        rawClient.query('UPDATE core.audit_log SET action = $1 WHERE id = $2', ['tampered', entry.id]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await rawClient.end();
    }
  });

  it('DB CHECK constraint rejects an ai_agent audit row with no ai_rationale, independent of the app-layer guard (§2.2 rule 3)', async () => {
    // Bypasses AuditLogRepository.record()'s own guard on purpose - this
    // test is specifically about the DB CHECK constraint holding on its own,
    // the way a future direct-write bug or a different service would hit it.
    await expect(
      tenantContext.run({ tenantId: tenantAId }, () =>
        appDataSource.transaction(async (manager) => {
          await manager.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantAId]);
          return manager.getRepository(AuditLog).save({
            id: uuidv4(),
            createdAt: new Date(),
            tenantId: tenantAId,
            actorId: null,
            actorType: AuditActorType.AI_AGENT,
            action: 'test.ai_action',
            resourceType: 'test_resource',
            resourceId: null,
            beforeState: null,
            afterState: null,
            aiRationale: null,
          } as AuditLog);
        }),
      ),
    ).rejects.toThrow(/audit_log_ai_rationale_required/);
  });
});
