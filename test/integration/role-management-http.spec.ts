import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant, User } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { Role } from '../../src/modules/identity/entities/role.entity';
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { SigningKeysRepository } from '../../src/modules/auth/repositories/signing-keys.repository';
import { TokenService } from '../../src/modules/auth/services/token.service';

dotenv.config();

/**
 * Frontend Phase 8 gap-fix (Roles Setup screen): `PATCH /v1/roles/:id` and
 * `GET /v1/roles/:id/users`, end to end over real HTTP + real Postgres,
 * same posture as `employee-api-http.spec.ts` (first file to exercise a
 * `AccessTokenGuard`+`PermissionsGuard`-guarded REST surface through the
 * real request pipeline with a minted, correctly-signed access token).
 * Also proves `POST /v1/users/:userId/roles` now succeeds for a system role
 * id (`RoleManagementService.assignRole`'s deliberate behavior change).
 */
describe('Role management API (REST, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let writeToken: string;
  let readOnlyToken: string;
  let tokenService: TokenService;

  const asWriter = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    (request(app.getHttpServer())[method](path) as request.Test)
      .set('x-tenant-id', tenantId)
      .set('Authorization', `Bearer ${writeToken}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

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

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Role Mgmt API Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    const signingKeyService = new SigningKeyService(new SigningKeysRepository(migratorDataSource));
    await signingKeyService.onModuleInit(); // idempotent - bootstraps a key only if none is active
    tokenService = new TokenService(signingKeyService, {
      get: (key: string, fallback?: string) =>
        ({ OIDC_ISSUER: 'https://auth.agno-wfm.local', OIDC_AUDIENCE: 'agno-core-api' })[key] ?? fallback,
    } as never);

    const { token: write } = await tokenService.issueAccessToken({
      userId: uuidv4(),
      tenantId,
      orgUnitId: null,
      roles: ['tenant_admin'],
      permissions: ['role:read', 'role:write'],
      amr: ['pwd'],
      authTime: new Date(),
    });
    writeToken = write;

    const { token: readOnly } = await tokenService.issueAccessToken({
      userId: uuidv4(),
      tenantId,
      orgUnitId: null,
      roles: ['tenant_admin'],
      permissions: ['role:read'],
      amr: ['pwd'],
      authTime: new Date(),
    });
    readOnlyToken = readOnly;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  const createTenantRole = async (): Promise<{ id: string; name: string }> => {
    const res = await asWriter('post', '/v1/roles')
      .send({ name: `Role ${uuidv4()}` })
      .expect(201);
    return res.body;
  };

  const createUser = async (): Promise<string> => {
    const user = await migratorDataSource.getRepository(User).save(
      migratorDataSource.getRepository(User).create({
        tenantId,
        email: `role-mgmt-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    return user.id;
  };

  it('PATCH /v1/roles/:id updates a tenant role and returns the refreshed row', async () => {
    const role = await createTenantRole();

    const res = await asWriter('patch', `/v1/roles/${role.id}`)
      .send({ name: 'Renamed Role', description: 'Updated via test', isDefault: true })
      .expect(200);

    expect(res.body.id).toBe(role.id);
    expect(res.body.name).toBe('Renamed Role');
    expect(res.body.description).toBe('Updated via test');
    expect(res.body.isDefault).toBe(true);

    const getRes = await asWriter('get', `/v1/roles/${role.id}`).expect(200);
    expect(getRes.body.name).toBe('Renamed Role');
  });

  it('PATCH /v1/roles/:id returns 403 when the caller lacks role:write', async () => {
    const role = await createTenantRole();

    const res = await request(app.getHttpServer())
      .patch(`/v1/roles/${role.id}`)
      .set('x-tenant-id', tenantId)
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .send({ name: 'Should not apply' })
      .expect(403);
    expect(res.body.message ?? res.body.error?.message).toMatch(/role:write/i);
  });

  /**
   * `RoleManagementService.updateRole` resolves the target with
   * `getRoleOrFail` (tenant-only, same family as `bindPermission`/
   * `deleteRole`) rather than the `...IncludingSystem` variant - a system
   * role (`tenant_id IS NULL`) can never match that tenant-scoped lookup,
   * so the edit is rejected as NOT_FOUND before the explicit
   * `SystemRoleImmutableError`/`isSystemRole` check inside `updateRole`
   * would even be reached. Either way, the system role is never editable
   * through this endpoint.
   */
  it('PATCH /v1/roles/:id rejects editing a system role', async () => {
    const systemRole = await migratorDataSource.getRepository(Role).save(
      migratorDataSource.getRepository(Role).create({
        tenantId: null,
        name: `system_role_${uuidv4()}`,
        isSystemRole: true,
      }),
    );

    const res = await asWriter('patch', `/v1/roles/${systemRole.id}`).send({ name: 'Hijacked' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(['NOT_FOUND', 'SYSTEM_ROLE_IMMUTABLE']).toContain(res.body.error?.code);
  });

  it('GET /v1/roles/:id/users returns one row per (user, scopeOrgUnitId) assignment', async () => {
    const role = await createTenantRole();
    const userA = await createUser();
    const userB = await createUser();
    const orgUnitId = uuidv4();

    await asWriter('post', `/v1/users/${userA}/roles`).send({ roleId: role.id }).expect(201);
    await asWriter('post', `/v1/users/${userB}/roles`).send({ roleId: role.id, scopeOrgUnitId: orgUnitId }).expect(201);
    // userA held twice, in two different scopes - must appear as two rows.
    await asWriter('post', `/v1/users/${userA}/roles`).send({ roleId: role.id, scopeOrgUnitId: orgUnitId }).expect(201);

    const res = await asWriter('get', `/v1/roles/${role.id}/users`).expect(200);
    const rows: Array<{ id: string; scopeOrgUnitId: string | null }> = res.body;

    expect(rows).toHaveLength(3);
    const userARows = rows.filter((r) => r.id === userA);
    expect(userARows).toHaveLength(2);
    expect(userARows.map((r) => r.scopeOrgUnitId).sort()).toEqual([null, orgUnitId].sort());
    const userBRows = rows.filter((r) => r.id === userB);
    expect(userBRows).toHaveLength(1);
    expect(userBRows[0].scopeOrgUnitId).toBe(orgUnitId);
  });

  /**
   * `RoleManagementService.assignRole` deliberate behavior change: it used
   * to look up the target role tenant-only (`getRoleOrFail`) and 404 for a
   * system role id even though `UserRole.roleId` was never actually
   * restricted to tenant-scoped roles. It now resolves via
   * `getRoleOrFailIncludingSystem`, so granting a system role succeeds.
   */
  it('POST /v1/users/:userId/roles succeeds for a system role id', async () => {
    const systemRole = await migratorDataSource.getRepository(Role).save(
      migratorDataSource.getRepository(Role).create({
        tenantId: null,
        name: `system_role_${uuidv4()}`,
        isSystemRole: true,
      }),
    );
    const userId = await createUser();

    const res = await asWriter('post', `/v1/users/${userId}/roles`).send({ roleId: systemRole.id }).expect(201);
    expect(res.body.roleId).toBe(systemRole.id);
    expect(res.body.userId).toBe(userId);
  });
});
