import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant, AuditLog } from '../../src/modules/entities';
import { OrgUnitHistory } from '../../src/modules/org-unit/entities/org-unit-history.entity';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { SigningKeysRepository } from '../../src/modules/auth/repositories/signing-keys.repository';
import { TokenService } from '../../src/modules/auth/services/token.service';

dotenv.config();

/**
 * Phase 3 (Employee CRUD, transfer/terminate, manager hierarchy) end-to-end
 * over the real HTTP/GraphQL surface, same posture as
 * `test/integration/org-api-http.spec.ts` (Phase 2).
 *
 * ADR-0157: `EmployeeResolver` gained real guards (`AccessTokenGuard`+
 * `PermissionsGuard`) closing ADR-0150's gap - this is the first
 * end-to-end HTTP integration test in this repo to exercise a
 * JWT-guarded resolver through the real request pipeline (every prior
 * guard-adjacent integration test, e.g. `rbac-abac-policy-versioning.spec.ts`,
 * calls the underlying RBAC/ABAC services directly, bypassing HTTP
 * entirely). `TokenService`/`SigningKeyService` construction mirrors
 * `auth-oauth-flow.spec.ts`'s own established pattern for minting a real,
 * correctly-signed access token in a test.
 */
describe('Employee API (GraphQL, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let orgUnitAId: string;
  let orgUnitBId: string;
  let accessToken: string;
  let tokenService: TokenService;

  // `tenant`/`token` both default to the primary test tenant/token - kept
  // as independent params (not derived from one another) because
  // ADR-0049's JWT-primary binding means the *token's own* `tenant_id`
  // claim decides tenant scope, not the `x-tenant-id` header, once a
  // valid Bearer token is present. A genuine cross-tenant test therefore
  // needs a second, real token minted for the other tenant - passing a
  // different `x-tenant-id` header alone (the old, pre-guard way this
  // test worked) would no longer actually simulate a different tenant.
  const gql = (
    query: string,
    variables?: Record<string, unknown>,
    tenant: string = tenantId,
    token: string = accessToken,
  ) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenant)
      .set('Authorization', `Bearer ${token}`)
      .send({ query, variables });

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
        name: `Employee API Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const orgUnitsRepo = migratorDataSource.getRepository(OrgUnit);
    const orgUnitA = await orgUnitsRepo.save(
      orgUnitsRepo.create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Employee Test Site A',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    const orgUnitB = await orgUnitsRepo.save(
      orgUnitsRepo.create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Employee Test Site B',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitAId = orgUnitA.id;
    orgUnitBId = orgUnitB.id;

    const signingKeyService = new SigningKeyService(new SigningKeysRepository(migratorDataSource));
    await signingKeyService.onModuleInit(); // idempotent - bootstraps a key only if none is active
    tokenService = new TokenService(signingKeyService, {
      get: (key: string, fallback?: string) =>
        ({ OIDC_ISSUER: 'https://auth.agno-wfm.local', OIDC_AUDIENCE: 'agno-core-api' })[key] ?? fallback,
    } as never);
    const { token } = await tokenService.issueAccessToken({
      userId: uuidv4(),
      tenantId,
      orgUnitId: null,
      roles: ['tenant_admin'],
      permissions: ['employee:read', 'employee:write'],
      amr: ['pwd'],
      authTime: new Date(),
    });
    accessToken = token;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('creates, reads, and lists an employee', async () => {
    const createRes = await gql(
      `mutation($input: CreateEmployeeInput!) {
        createEmployee(input: $input) { id employeeNumber status orgUnitId contractHoursPerWeek }
      }`,
      {
        input: {
          orgUnitId: orgUnitAId,
          employeeNumber: `EMP-${uuidv4()}`,
          employmentType: 'FULL_TIME',
          contractHoursPerWeek: 40,
          hireDate: '2024-01-15',
        },
      },
    ).expect(200);
    expect(createRes.body.errors).toBeUndefined();
    const employeeId = createRes.body.data.createEmployee.id;
    expect(createRes.body.data.createEmployee.status).toBe('PENDING_ONBOARDING');

    const readRes = await gql(`query { employee(id: "${employeeId}") { id orgUnit { id name } } }`).expect(200);
    expect(readRes.body.data.employee.orgUnit.id).toBe(orgUnitAId);

    const listRes = await gql(`query($filter: EmployeeFilterInput) { employees(filter: $filter) { id } }`, {
      filter: { orgUnitId: orgUnitAId },
    }).expect(200);
    expect(listRes.body.data.employees.map((e: { id: string }) => e.id)).toContain(employeeId);
  });

  /**
   * GAP-06 (enterprise readiness audit, 2026-08-18): `EmployeeResolver`'s
   * mutations previously never called the audit-log writer used everywhere
   * else in Module 01 - this proves the fix end to end, not just that the
   * resolver compiles against `AuditLogRepository`.
   */
  it('createEmployee/updateEmployee/transferEmployee each record an audit_log entry', async () => {
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-01-15',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    const auditLogRepo = migratorDataSource.getRepository(AuditLog);
    const createdEntry = await auditLogRepo.findOne({
      where: { tenantId, resourceId: employeeId, action: 'employee.created' } as never,
    });
    expect(createdEntry).not.toBeNull();
    expect(createdEntry?.resourceType).toBe('employee');
    expect(createdEntry?.beforeState).toBeNull();
    expect(createdEntry?.afterState).not.toBeNull();

    await gql(`mutation($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id } }`, {
      id: employeeId,
      input: { costCenter: 'CC-AUDIT' },
    }).expect(200);
    const updatedEntry = await auditLogRepo.findOne({
      where: { tenantId, resourceId: employeeId, action: 'employee.updated' } as never,
    });
    expect(updatedEntry).not.toBeNull();
    expect(updatedEntry?.beforeState).not.toBeNull();

    await gql(
      `mutation($employeeId: ID!, $newOrgUnitId: ID!) {
        transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId) { id }
      }`,
      { employeeId, newOrgUnitId: orgUnitBId },
    ).expect(200);
    const transferredEntry = await auditLogRepo.findOne({
      where: { tenantId, resourceId: employeeId, action: 'employee.transferred' } as never,
    });
    expect(transferredEntry).not.toBeNull();
  });

  /**
   * GAP-06 (enterprise readiness audit, 2026-08-18): `OrgUnitResolver`'s
   * mutations previously never called the audit-log writer either -
   * `org-api-http.spec.ts` predates ADR-0150's guards (still uses the old
   * `x-tenant-id`-only style against a now-JWT-gated resolver), so this is
   * verified here instead, alongside `EmployeeResolver`'s own equivalent
   * test and reusing this file's already-JWT-authenticated `gql()` helper.
   */
  it('createOrgUnit/updateOrgUnit each record an audit_log entry', async () => {
    const createRes = await gql(`mutation($input: CreateOrgUnitInput!) { createOrgUnit(input: $input) { id } }`, {
      input: { type: 'BUSINESS_UNIT', name: `Audit Test Org Unit ${uuidv4()}`, timezone: 'UTC', countryCode: 'US' },
    }).expect(200);
    const orgUnitId = createRes.body.data.createOrgUnit.id;

    const auditLogRepo = migratorDataSource.getRepository(AuditLog);
    const createdEntry = await auditLogRepo.findOne({
      where: { tenantId, resourceId: orgUnitId, action: 'org_unit.created' } as never,
    });
    expect(createdEntry).not.toBeNull();
    expect(createdEntry?.resourceType).toBe('org_unit');
    expect(createdEntry?.beforeState).toBeNull();

    await gql(`mutation($id: ID!, $input: UpdateOrgUnitInput!) { updateOrgUnit(id: $id, input: $input) { id } }`, {
      id: orgUnitId,
      input: { name: 'Renamed via audit test' },
    }).expect(200);
    const updatedEntry = await auditLogRepo.findOne({
      where: { tenantId, resourceId: orgUnitId, action: 'org_unit.updated' } as never,
    });
    expect(updatedEntry).not.toBeNull();
    expect(updatedEntry?.beforeState).not.toBeNull();
  });

  /**
   * GAP-07 (enterprise readiness audit, 2026-08-18): `OrgUnitResolver`'s
   * `updateOrgUnit` gets the same backdated/future-dated support as
   * `updateEmployee` - `org.fn_org_unit_history_track()` is the sibling
   * trigger `1700000017000` also fixed.
   */
  it('updateOrgUnit with effectiveDate backdates the OrgUnitHistory version, not "now"', async () => {
    const createRes = await gql(`mutation($input: CreateOrgUnitInput!) { createOrgUnit(input: $input) { id } }`, {
      input: { type: 'BUSINESS_UNIT', name: `Backdate Test Org Unit ${uuidv4()}`, timezone: 'UTC', countryCode: 'US' },
    }).expect(200);
    const orgUnitId = createRes.body.data.createOrgUnit.id;

    const backdatedTo = new Date();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await gql(`mutation($id: ID!, $input: UpdateOrgUnitInput!) { updateOrgUnit(id: $id, input: $input) { id } }`, {
      id: orgUnitId,
      input: { name: 'Renamed with effectiveDate', effectiveDate: backdatedTo.toISOString() },
    }).expect(200);

    const historyRepo = migratorDataSource.getRepository(OrgUnitHistory);
    const history = await historyRepo.find({ where: { orgUnitId } as never, order: { validFrom: 'ASC' } as never });
    expect(history).toHaveLength(2);
    const [closed, open] = history;
    expect(open.name).toBe('Renamed with effectiveDate');
    expect(Math.abs(closed.validTo!.getTime() - backdatedTo.getTime())).toBeLessThan(2000);
    expect(Math.abs(open.validFrom.getTime() - backdatedTo.getTime())).toBeLessThan(2000);
  });

  it('updateEmployee changes non-structural fields and terminating defaults terminationDate', async () => {
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'PART_TIME',
        contractHoursPerWeek: 20,
        hireDate: '2024-02-01',
      },
    }).expect(200);
    const id = createRes.body.data.createEmployee.id;

    const updateRes = await gql(
      `mutation($id: ID!, $input: UpdateEmployeeInput!) {
        updateEmployee(id: $id, input: $input) { id costCenter status }
      }`,
      { id, input: { costCenter: 'CC-42' } },
    ).expect(200);
    expect(updateRes.body.data.updateEmployee.costCenter).toBe('CC-42');
    expect(updateRes.body.data.updateEmployee.status).toBe('PENDING_ONBOARDING');

    const terminateRes = await gql(
      `mutation($id: ID!, $input: UpdateEmployeeInput!) {
        updateEmployee(id: $id, input: $input) { id status terminationDate }
      }`,
      { id, input: { status: 'TERMINATED' } },
    ).expect(200);
    expect(terminateRes.body.data.updateEmployee.status).toBe('TERMINATED');
    expect(terminateRes.body.data.updateEmployee.terminationDate).not.toBeNull();
  });

  /**
   * GAP-07 (enterprise readiness audit, 2026-08-18): "No backdated or
   * future-dated change support anywhere in employee/org-unit writes" -
   * proves `updateEmployee`'s new `effectiveDate` arg actually reaches
   * `org.fn_employee_history_track()` (via the `app.effective_at` GUC,
   * `1700000017000`) rather than every correction landing as "effective
   * right now" regardless of what the caller asked for.
   */
  it('updateEmployee with effectiveDate backdates the EmployeeHistory version, not "now"', async () => {
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-01-15',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    // Captured strictly after the create above committed (so it's after the
    // opening version's own valid_from, satisfying employee_history_valid_range)
    // and strictly before the update below actually executes (so a
    // non-backdated implementation would visibly land later than this).
    const backdatedTo = new Date();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await gql(`mutation($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id } }`, {
      id: employeeId,
      input: { costCenter: 'CC-BACKDATED', effectiveDate: backdatedTo.toISOString() },
    }).expect(200);

    const historyRes = await gql(
      `query { employeeHistory(employeeId: "${employeeId}") { validFrom validTo costCenter } }`,
    ).expect(200);
    const history = historyRes.body.data.employeeHistory as {
      validFrom: string;
      validTo: string | null;
      costCenter: string | null;
    }[];
    expect(history).toHaveLength(2);
    const [closed, open] = history;
    expect(closed.costCenter).toBeNull();
    expect(open.costCenter).toBe('CC-BACKDATED');
    // Both boundaries land at backdatedTo, not at whenever the mutation
    // actually ran (which is at least 50ms later) - within 2s tolerance for
    // serialization/precision, nowhere near the 50ms gap to "now."
    expect(Math.abs(new Date(closed.validTo!).getTime() - backdatedTo.getTime())).toBeLessThan(2000);
    expect(Math.abs(new Date(open.validFrom).getTime() - backdatedTo.getTime())).toBeLessThan(2000);
  });

  it('transferEmployee moves org unit + manager and is reflected in employeeHistory', async () => {
    const managerRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitBId,
        employeeNumber: `MGR-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2023-01-01',
      },
    }).expect(200);
    const managerId = managerRes.body.data.createEmployee.id;

    const employeeRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-03-01',
      },
    }).expect(200);
    const employeeId = employeeRes.body.data.createEmployee.id;

    const transferRes = await gql(
      `mutation($employeeId: ID!, $newOrgUnitId: ID!, $newManagerEmployeeId: ID) {
        transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId, newManagerEmployeeId: $newManagerEmployeeId) {
          id orgUnitId managerEmployeeId
        }
      }`,
      { employeeId, newOrgUnitId: orgUnitBId, newManagerEmployeeId: managerId },
    ).expect(200);
    expect(transferRes.body.errors).toBeUndefined();
    expect(transferRes.body.data.transferEmployee.orgUnitId).toBe(orgUnitBId);
    expect(transferRes.body.data.transferEmployee.managerEmployeeId).toBe(managerId);

    const historyRes = await gql(`query { employeeHistory(employeeId: "${employeeId}") { orgUnitId validTo } }`).expect(
      200,
    );
    const history = historyRes.body.data.employeeHistory as { orgUnitId: string; validTo: string | null }[];
    expect(history).toHaveLength(2);
    expect(history[0].orgUnitId).toBe(orgUnitAId);
    expect(history[0].validTo).not.toBeNull();
    expect(history[1].orgUnitId).toBe(orgUnitBId);
    expect(history[1].validTo).toBeNull();

    const managerFieldRes = await gql(`query { employee(id: "${employeeId}") { manager { id } } }`).expect(200);
    expect(managerFieldRes.body.data.employee.manager.id).toBe(managerId);

    const reportsRes = await gql(`query { employee(id: "${managerId}") { directReports { id } } }`).expect(200);
    expect(reportsRes.body.data.employee.directReports.map((e: { id: string }) => e.id)).toContain(employeeId);
  });

  it('transferEmployee to a nonexistent org unit returns NOT_FOUND, not a raw FK error', async () => {
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-04-01',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    const res = await gql(
      `mutation($employeeId: ID!, $newOrgUnitId: ID!) {
        transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId) { id }
      }`,
      { employeeId, newOrgUnitId: uuidv4() },
    ).expect(200);
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it("an employee created under one tenant is invisible to another tenant's employee(id) query", async () => {
    const otherTenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Employee API Other Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );

    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-05-01',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    const { token: otherTenantToken } = await tokenService.issueAccessToken({
      userId: uuidv4(),
      tenantId: otherTenant.id,
      orgUnitId: null,
      roles: ['tenant_admin'],
      permissions: ['employee:read', 'employee:write'],
      amr: ['pwd'],
      authTime: new Date(),
    });
    const crossTenantRes = await gql(
      `query { employee(id: "${employeeId}") { id } }`,
      undefined,
      otherTenant.id,
      otherTenantToken,
    ).expect(200);
    expect(crossTenantRes.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('updateEmployee can link a userId, and me.employee resolves it back', async () => {
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-06-01',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    // `sub` of the primary test token, minted in beforeAll - the session
    // this whole file's `gql()` calls authenticate as.
    const meBefore = await gql(`query { me { id employee { id } } }`).expect(200);
    const sessionUserId = meBefore.body.data.me.id;
    expect(meBefore.body.data.me.employee).toBeNull();

    const linkRes = await gql(
      `mutation($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id userId } }`,
      { id: employeeId, input: { userId: sessionUserId } },
    ).expect(200);
    expect(linkRes.body.errors).toBeUndefined();
    expect(linkRes.body.data.updateEmployee.userId).toBe(sessionUserId);

    const meAfter = await gql(`query { me { employee { id } } }`).expect(200);
    expect(meAfter.body.data.me.employee.id).toBe(employeeId);
  });

  it('updateEmployee rejects linking a userId already linked to a different employee', async () => {
    const firstRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-06-02',
      },
    }).expect(200);
    const secondRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-06-03',
      },
    }).expect(200);
    const firstId = firstRes.body.data.createEmployee.id;
    const secondId = secondRes.body.data.createEmployee.id;
    const contestedUserId = uuidv4();

    await gql(`mutation($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id } }`, {
      id: firstId,
      input: { userId: contestedUserId },
    }).expect(200);

    const conflictRes = await gql(
      `mutation($id: ID!, $input: UpdateEmployeeInput!) { updateEmployee(id: $id, input: $input) { id } }`,
      { id: secondId, input: { userId: contestedUserId } },
    ).expect(200);
    expect(conflictRes.body.errors[0].extensions.code).toBe('USER_ALREADY_LINKED');
  });

  it('EmployeeResolver rejects a request with no access token at all', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .send({ query: `query { employees { id } }` })
      .expect(200);
    expect(res.body.errors[0].message).toMatch(/bearer|unauthorized/i);
  });

  /**
   * GAP-07 (enterprise readiness audit, 2026-08-18): "skill and calendar
   * history are entirely absent" - proves `updateEmployeeSkills`'
   * proficiency-level change is actually versioned in
   * `EmployeeSkillHistory` (`org.fn_employee_skill_history_track`,
   * `1700000018000`), not just silently overwritten in place.
   */
  it('updateEmployeeSkills changes are recorded in EmployeeSkillHistory', async () => {
    const employeeRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId: orgUnitAId,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2024-01-15',
      },
    }).expect(200);
    const employeeId = employeeRes.body.data.createEmployee.id;

    const skillRes = await gql(`mutation($input: CreateSkillInput!) { createSkill(input: $input) { id } }`, {
      input: { name: `Audit Test Skill ${uuidv4()}`, category: 'test', requiresCertification: false },
    }).expect(200);
    const skillId = skillRes.body.data.createSkill.id;

    await gql(`mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId } }`, {
      input: { employeeId, skills: [{ skillId, proficiencyLevel: 'TRAINEE' }] },
    }).expect(200);
    await gql(`mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId } }`, {
      input: { employeeId, skills: [{ skillId, proficiencyLevel: 'EXPERT' }] },
    }).expect(200);

    const historyRes = await gql(
      `query($employeeId: ID!, $skillId: ID!) {
        employeeSkillHistory(employeeId: $employeeId, skillId: $skillId) { validFrom validTo proficiencyLevel }
      }`,
      { employeeId, skillId },
    ).expect(200);
    const history = historyRes.body.data.employeeSkillHistory as {
      validFrom: string;
      validTo: string | null;
      proficiencyLevel: string;
    }[];
    expect(history).toHaveLength(2);
    expect(history[0].proficiencyLevel).toBe('TRAINEE');
    expect(history[0].validTo).not.toBeNull();
    expect(history[1].proficiencyLevel).toBe('EXPERT');
    expect(history[1].validTo).toBeNull();
  });

  /**
   * GAP-07 (enterprise readiness audit, 2026-08-18): same proof for
   * `WorkingTimeCalendarsService.upsert` (`org.fn_working_time_calendar_history_track`).
   * Calendars are a REST-only surface (`POST /v1/calendars`), not GraphQL -
   * see `UpsertWorkingTimeCalendarInput`'s own doc comment.
   */
  it('calendar upsert changes are recorded in WorkingTimeCalendarHistory', async () => {
    const orgUnitRes = await gql(`mutation($input: CreateOrgUnitInput!) { createOrgUnit(input: $input) { id } }`, {
      input: { type: 'SITE', name: `Calendar History Test Site ${uuidv4()}`, timezone: 'UTC', countryCode: 'US' },
    }).expect(200);
    const orgUnitId = orgUnitRes.body.data.createOrgUnit.id;

    const restHeaders = { 'x-tenant-id': tenantId, Authorization: `Bearer ${accessToken}` };

    const createRes = await request(app.getHttpServer())
      .post('/v1/calendars')
      .set(restHeaders)
      .send({ orgUnitId, countryCode: 'US', timezone: 'UTC', holidayDates: [], standardBusinessHours: {} })
      .expect(201);
    const calendarId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/v1/calendars')
      .set(restHeaders)
      .send({ orgUnitId, countryCode: 'CA', timezone: 'UTC', holidayDates: [], standardBusinessHours: {} })
      .expect(201);

    const historyRes = await gql(
      `query($calendarId: ID!) {
        workingTimeCalendarHistory(calendarId: $calendarId) { validFrom validTo countryCode }
      }`,
      { calendarId },
    ).expect(200);
    const history = historyRes.body.data.workingTimeCalendarHistory as {
      validFrom: string;
      validTo: string | null;
      countryCode: string;
    }[];
    expect(history).toHaveLength(2);
    expect(history[0].countryCode).toBe('US');
    expect(history[0].validTo).not.toBeNull();
    expect(history[1].countryCode).toBe('CA');
    expect(history[1].validTo).toBeNull();
  });
});
