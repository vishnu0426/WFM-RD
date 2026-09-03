import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { entities, Tenant, User, Permission } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { PermissionAction } from '../../src/modules/identity/entities/permission-action.enum';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { RolesRepository } from '../../src/modules/identity/repositories/roles.repository';
import { RolePermissionsRepository } from '../../src/modules/identity/repositories/role-permissions.repository';
import { UserRolesRepository } from '../../src/modules/identity/repositories/user-roles.repository';
import { AbacService } from '../../src/modules/policy/services/abac.service';
import { PoliciesRepository } from '../../src/modules/policy/repositories/policies.repository';
import { PolicyType } from '../../src/modules/policy/entities/policy-type.enum';

dotenv.config();

/**
 * Phase 4 (§4): RBAC-vs-ABAC distinction (a role's grant is exact-org-unit-
 * scoped or tenant-wide, `AbacService`) and policy lineage versioning
 * (`PoliciesRepository.createLineage`/`.supersede`, ADR-0006), against a
 * real Postgres.
 */
describe('Phase 4 - RBAC/ABAC and policy versioning (real Postgres)', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let tenantContext: TenantContextService;
  let rolesRepository: RolesRepository;
  let rolePermissionsRepository: RolePermissionsRepository;
  let userRolesRepository: UserRolesRepository;
  let abacService: AbacService;
  let policiesRepository: PoliciesRepository;

  let tenantId: string;
  let userId: string;
  let permissionId: string;
  const orgUnitA = uuidv4();
  const orgUnitB = uuidv4();

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
    rolesRepository = new RolesRepository(appDataSource, tenantContext);
    rolePermissionsRepository = new RolePermissionsRepository(appDataSource, tenantContext);
    userRolesRepository = new UserRolesRepository(appDataSource, tenantContext);
    abacService = new AbacService(appDataSource, tenantContext);
    policiesRepository = new PoliciesRepository(appDataSource, tenantContext);

    const tenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `RBAC ABAC Test Tenant ${uuidv4()}`,
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
        email: `rbac-abac-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
        mfaEnabled: false,
      }),
    );
    userId = user.id;

    // Permission catalog is global reference data (no RLS) - reuse an
    // existing row if the seed script already ran, otherwise create one.
    const permissionRepo = migratorDataSource.getRepository(Permission);
    let permission = await permissionRepo.findOne({
      where: { resource: 'rbac_abac_test_resource', action: PermissionAction.WRITE },
    });
    if (!permission) {
      permission = await permissionRepo.save(
        permissionRepo.create({ resource: 'rbac_abac_test_resource', action: PermissionAction.WRITE }),
      );
    }
    permissionId = permission.id;
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('a role scoped to one org unit grants ABAC access only for that exact org unit', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const role = await rolesRepository.create({ name: `Scoped Role ${uuidv4()}` });
      await rolePermissionsRepository.bind(role.id, permissionId);
      await userRolesRepository.assign(userId, role.id, orgUnitA);

      await expect(
        abacService.isPermittedForOrgUnit(userId, 'rbac_abac_test_resource', 'write', orgUnitA),
      ).resolves.toBe(true);
      await expect(
        abacService.isPermittedForOrgUnit(userId, 'rbac_abac_test_resource', 'write', orgUnitB),
      ).resolves.toBe(false);
      await expect(abacService.isPermittedForOrgUnit(userId, 'rbac_abac_test_resource', 'write', null)).resolves.toBe(
        false,
      );
    });
  });

  it('a tenant-wide role assignment grants ABAC access for every org unit, including none', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const role = await rolesRepository.create({ name: `Tenant-Wide Role ${uuidv4()}` });
      await rolePermissionsRepository.bind(role.id, permissionId);
      await userRolesRepository.assign(userId, role.id, null);

      await expect(
        abacService.isPermittedForOrgUnit(userId, 'rbac_abac_test_resource', 'write', orgUnitB),
      ).resolves.toBe(true);
      await expect(abacService.isPermittedForOrgUnit(userId, 'rbac_abac_test_resource', 'write', null)).resolves.toBe(
        true,
      );
    });
  });

  it('policy lineage versioning: supersede closes the old version and opens a new one atomically', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const v1EffectiveFrom = new Date('2026-01-01T00:00:00Z');
      const v1 = await policiesRepository.createLineage({
        policyType: PolicyType.OVERTIME_RULE,
        orgUnitId: null,
        definition: { dailyThresholdHours: 8 },
        effectiveFrom: v1EffectiveFrom,
      });
      expect(v1.version).toBe(1);
      expect(v1.effectiveTo).toBeNull();

      const v2EffectiveFrom = new Date('2026-06-01T00:00:00Z');
      const v2 = await policiesRepository.supersede(v1.policyGroupId, {
        policyType: PolicyType.OVERTIME_RULE,
        orgUnitId: null,
        definition: { dailyThresholdHours: 10 },
        effectiveFrom: v2EffectiveFrom,
      });
      expect(v2.version).toBe(2);
      expect(v2.effectiveTo).toBeNull();

      const history = await policiesRepository.history(v1.policyGroupId);
      expect(history).toHaveLength(2);
      expect(history[0].version).toBe(1);
      expect(history[0].effectiveTo?.toISOString()).toBe(v2EffectiveFrom.toISOString());
      expect(history[1].version).toBe(2);

      const activeDuringV1 = await policiesRepository.findActiveAsOf(
        v1.policyGroupId,
        new Date('2026-03-01T00:00:00Z'),
      );
      expect(activeDuringV1?.version).toBe(1);

      const activeDuringV2 = await policiesRepository.findActiveAsOf(
        v1.policyGroupId,
        new Date('2026-07-01T00:00:00Z'),
      );
      expect(activeDuringV2?.version).toBe(2);
    });
  });

  it('findActiveByTypeAndScope resolves the tenant-wide vs. org-unit-scoped lineage independently', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const asOf = new Date();
      await policiesRepository.createLineage({
        policyType: PolicyType.BREAK_RULE,
        orgUnitId: null,
        definition: { minMinutes: 30 },
        effectiveFrom: asOf,
      });
      const scoped = await policiesRepository.createLineage({
        policyType: PolicyType.BREAK_RULE,
        orgUnitId: orgUnitA,
        definition: { minMinutes: 45 },
        effectiveFrom: asOf,
      });

      const tenantWide = await policiesRepository.findActiveByTypeAndScope(PolicyType.BREAK_RULE, null, asOf);
      expect(tenantWide?.orgUnitId).toBeNull();

      const forOrgUnitA = await policiesRepository.findActiveByTypeAndScope(PolicyType.BREAK_RULE, orgUnitA, asOf);
      expect(forOrgUnitA?.id).toBe(scoped.id);

      const forOrgUnitB = await policiesRepository.findActiveByTypeAndScope(PolicyType.BREAK_RULE, orgUnitB, asOf);
      expect(forOrgUnitB).toBeNull();
    });
  });

  it('deactivate closes the open version with no successor (Module 11 Gap 1 - geofencing kill-switch)', async () => {
    await tenantContext.run({ tenantId }, async () => {
      const v1 = await policiesRepository.createLineage({
        policyType: PolicyType.GEOFENCE_BOUNDARY,
        orgUnitId: orgUnitA,
        definition: { centerLatitude: 37.7749, centerLongitude: -122.4194, radiusMeters: 100 },
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const deactivated = await policiesRepository.deactivate(v1.policyGroupId);
      expect(deactivated.version).toBe(1);
      expect(deactivated.effectiveTo).not.toBeNull();

      const stillOpen = await policiesRepository.findOpenVersion(v1.policyGroupId);
      expect(stillOpen).toBeNull();

      const activeNow = await policiesRepository.findActiveAsOf(v1.policyGroupId, new Date());
      expect(activeNow).toBeNull();

      const history = await policiesRepository.history(v1.policyGroupId);
      expect(history).toHaveLength(1);
      expect(history[0].version).toBe(1);
    });
  });

  it('deactivate throws PolicyNotFoundError for an unknown lineage', async () => {
    await tenantContext.run({ tenantId }, async () => {
      await expect(policiesRepository.deactivate(uuidv4())).rejects.toThrow();
    });
  });
});
