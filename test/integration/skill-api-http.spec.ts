import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';
import { Employee } from '../../src/modules/employee/entities/employee.entity';
import { EmploymentType } from '../../src/modules/employee/entities/employment-type.enum';
import { EmployeeStatus } from '../../src/modules/employee/entities/employee-status.enum';

dotenv.config();

/** Phase 4 (Skills & competency) end-to-end over the real HTTP/GraphQL surface. */
describe('Skill API (GraphQL + REST, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let employeeId: string;

  const gql = (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/graphql').set('x-tenant-id', tenantId).send({ query, variables });

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
        name: `Skill API Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    await migratorDataSource.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId]);
    const orgUnit = await migratorDataSource.getRepository(OrgUnit).save(
      migratorDataSource.getRepository(OrgUnit).create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Skill Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    const employee = await migratorDataSource.getRepository(Employee).save(
      migratorDataSource.getRepository(Employee).create({
        id: uuidv4(),
        tenantId,
        userId: null,
        orgUnitId: orgUnit.id,
        employeeNumber: `EMP-${uuidv4()}`,
        employmentType: EmploymentType.FULL_TIME,
        contractHoursPerWeek: '40.00',
        hireDate: '2024-01-01',
        terminationDate: null,
        costCenter: null,
        managerEmployeeId: null,
        status: EmployeeStatus.ACTIVE,
      }),
    );
    employeeId = employee.id;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('creates a skill and assigns it to an employee via updateEmployeeSkills', async () => {
    const createSkillRes = await gql(
      `mutation($input: CreateSkillInput!) { createSkill(input: $input) { id name requiresCertification } }`,
      {
        input: {
          name: 'Forklift Operation',
          category: 'warehouse',
          requiresCertification: true,
          certificationValidityDays: 365,
        },
      },
    ).expect(200);
    expect(createSkillRes.body.errors).toBeUndefined();
    const skillId = createSkillRes.body.data.createSkill.id;

    const updateRes = await gql(
      `mutation($input: UpdateEmployeeSkillsInput!) {
        updateEmployeeSkills(input: $input) { skillId proficiencyLevel certifiedDate expiryDate }
      }`,
      { input: { employeeId, skills: [{ skillId, proficiencyLevel: 'PROFICIENT', certifiedDate: '2025-01-01' }] } },
    ).expect(200);
    expect(updateRes.body.errors).toBeUndefined();
    const assigned = updateRes.body.data.updateEmployeeSkills[0];
    expect(assigned.skillId).toBe(skillId);
    // org.fn_employee_skill_set_expiry (Phase 1 trigger): 2025-01-01 + 365 days.
    expect(assigned.expiryDate).toBe('2026-01-01');

    const employeeSkillsRes = await gql(
      `query { employee(id: "${employeeId}") { skills { skillId skill { name } } } }`,
    ).expect(200);
    expect(employeeSkillsRes.body.data.employee.skills.map((s: { skillId: string }) => s.skillId)).toContain(skillId);
    expect(employeeSkillsRes.body.data.employee.skills[0].skill.name).toBe('Forklift Operation');
  });

  it('re-running updateEmployeeSkills for the same skill updates it in place, not duplicates', async () => {
    const createSkillRes = await gql(`mutation($input: CreateSkillInput!) { createSkill(input: $input) { id } }`, {
      input: { name: `Customer Service ${uuidv4()}`, category: 'soft_skill', requiresCertification: false },
    }).expect(200);
    const skillId = createSkillRes.body.data.createSkill.id;

    await gql(
      `mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId proficiencyLevel } }`,
      { input: { employeeId, skills: [{ skillId, proficiencyLevel: 'TRAINEE' }] } },
    ).expect(200);

    const secondRes = await gql(
      `mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId proficiencyLevel } }`,
      { input: { employeeId, skills: [{ skillId, proficiencyLevel: 'EXPERT' }] } },
    ).expect(200);

    const matches = (
      secondRes.body.data.updateEmployeeSkills as { skillId: string; proficiencyLevel: string }[]
    ).filter((s) => s.skillId === skillId);
    expect(matches).toHaveLength(1);
    expect(matches[0].proficiencyLevel).toBe('EXPERT');
  });

  it('updateEmployeeSkills with an unknown skillId returns NOT_FOUND', async () => {
    const res = await gql(
      `mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId } }`,
      { input: { employeeId, skills: [{ skillId: uuidv4(), proficiencyLevel: 'TRAINEE' }] } },
    ).expect(200);
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('REST GET /v1/employees/{id}/skills and GET /v1/skills/expiring return real data', async () => {
    const createSkillRes = await gql(`mutation($input: CreateSkillInput!) { createSkill(input: $input) { id } }`, {
      input: {
        name: `Expiring Soon ${uuidv4()}`,
        category: 'test',
        requiresCertification: true,
        certificationValidityDays: 5,
      },
    }).expect(200);
    const skillId = createSkillRes.body.data.createSkill.id;

    await gql(`mutation($input: UpdateEmployeeSkillsInput!) { updateEmployeeSkills(input: $input) { skillId } }`, {
      input: {
        employeeId,
        skills: [{ skillId, proficiencyLevel: 'PROFICIENT', certifiedDate: new Date().toISOString().slice(0, 10) }],
      },
    }).expect(200);

    const skillsRes = await request(app.getHttpServer())
      .get(`/v1/employees/${employeeId}/skills`)
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(
      skillsRes.body.some((s: { skill_id: string; skillId: string }) => (s.skillId ?? s.skill_id) === skillId),
    ).toBe(true);

    const expiringRes = await request(app.getHttpServer())
      .get('/v1/skills/expiring')
      .query({ within_days: 10 })
      .set('x-tenant-id', tenantId)
      .expect(200);
    expect(expiringRes.body.some((s: { skillId: string }) => s.skillId === skillId)).toBe(true);
  });

  it('updateSkill changes description/status without touching other fields', async () => {
    const createSkillRes = await gql(
      `mutation($input: CreateSkillInput!) {
        createSkill(input: $input) { id name category requiresCertification certificationValidityDays description status }
      }`,
      {
        input: {
          name: `Pallet Jack Operation ${uuidv4()}`,
          category: 'warehouse',
          requiresCertification: true,
          certificationValidityDays: 180,
        },
      },
    ).expect(200);
    expect(createSkillRes.body.errors).toBeUndefined();
    const created = createSkillRes.body.data.createSkill;
    expect(created.description).toBeNull();
    expect(created.status).toBe('ACTIVE');

    const updateRes = await gql(
      `mutation($input: UpdateSkillInput!) {
        updateSkill(input: $input) { id name category requiresCertification certificationValidityDays description status }
      }`,
      { input: { id: created.id, description: 'Operates a manual/electric pallet jack', status: 'DISABLED' } },
    ).expect(200);
    expect(updateRes.body.errors).toBeUndefined();
    const updated = updateRes.body.data.updateSkill;

    expect(updated.id).toBe(created.id);
    expect(updated.description).toBe('Operates a manual/electric pallet jack');
    expect(updated.status).toBe('DISABLED');
    // Untouched fields survive the partial update unchanged.
    expect(updated.name).toBe(created.name);
    expect(updated.category).toBe(created.category);
    expect(updated.requiresCertification).toBe(created.requiresCertification);
    expect(updated.certificationValidityDays).toBe(created.certificationValidityDays);
  });

  it("a skill created under one tenant is invisible to another tenant's query", async () => {
    const otherTenant = await migratorDataSource.getRepository(Tenant).save(
      migratorDataSource.getRepository(Tenant).create({
        name: `Skill API Other Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    const createSkillRes = await gql(`mutation($input: CreateSkillInput!) { createSkill(input: $input) { id } }`, {
      input: { name: `Tenant-scoped skill ${uuidv4()}`, category: 'test', requiresCertification: false },
    }).expect(200);
    const skillId = createSkillRes.body.data.createSkill.id;

    const crossTenantRes = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', otherTenant.id)
      .send({ query: `query { skill(id: "${skillId}") { id } }` })
      .expect(200);
    expect(crossTenantRes.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});
