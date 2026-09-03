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

dotenv.config();

/** Phase 5 (Calendars & Employment Policy) end-to-end over the real HTTP/GraphQL surface. */
describe('Calendar + EmploymentPolicy API (REST + GraphQL, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let orgUnitId: string;

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
        name: `Calendar Policy Test Tenant ${uuidv4()}`,
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
        name: 'Calendar Policy Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitId = orgUnit.id;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('POST /v1/calendars creates the tenant default, then a second call updates it in place', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/v1/calendars')
      .set('x-tenant-id', tenantId)
      .send({
        countryCode: 'US',
        timezone: 'America/New_York',
        holidayDates: ['2026-01-01'],
        standardBusinessHours: { mon: ['09:00', '17:00'] },
      })
      .expect(201);
    expect(createRes.body.timezone).toBe('America/New_York');
    const id = createRes.body.id;

    const updateRes = await request(app.getHttpServer())
      .post('/v1/calendars')
      .set('x-tenant-id', tenantId)
      .send({
        countryCode: 'US',
        timezone: 'America/Chicago',
        holidayDates: ['2026-01-01', '2026-07-04'],
        standardBusinessHours: { mon: ['08:00', '16:00'] },
      })
      .expect(201);
    expect(updateRes.body.id).toBe(id);
    expect(updateRes.body.timezone).toBe('America/Chicago');

    const readRes = await gql(`query { workingTimeCalendar { id timezone holidayDates } }`).expect(200);
    expect(readRes.body.data.workingTimeCalendar.id).toBe(id);
    expect(readRes.body.data.workingTimeCalendar.timezone).toBe('America/Chicago');
    expect(readRes.body.data.workingTimeCalendar.holidayDates).toEqual(['2026-01-01', '2026-07-04']);
  });

  it('POST /v1/calendars scoped to an org unit is independent of the tenant default', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/calendars')
      .set('x-tenant-id', tenantId)
      .send({ orgUnitId, countryCode: 'GB', timezone: 'Europe/London', holidayDates: [], standardBusinessHours: {} })
      .expect(201);
    expect(res.body.orgUnitId).toBe(orgUnitId);

    const scopedRes = await gql(`query($orgUnitId: ID) { workingTimeCalendar(orgUnitId: $orgUnitId) { timezone } }`, {
      orgUnitId,
    }).expect(200);
    expect(scopedRes.body.data.workingTimeCalendar.timezone).toBe('Europe/London');

    const defaultRes = await gql(`query { workingTimeCalendar { timezone } }`).expect(200);
    expect(defaultRes.body.data.workingTimeCalendar.timezone).not.toBe('Europe/London');
  });

  it('createEmploymentPolicy starts a lineage, and a second call with policyGroupId supersedes it', async () => {
    const firstRes = await gql(
      `mutation($input: CreateEmploymentPolicyInput!) {
        createEmploymentPolicy(input: $input) { id policyGroupId version effectiveTo definition }
      }`,
      {
        input: {
          policyType: 'OVERTIME_THRESHOLD',
          orgUnitId,
          definition: { dailyThresholdHours: 8 },
          effectiveFrom: '2025-01-01T00:00:00.000Z',
        },
      },
    ).expect(200);
    expect(firstRes.body.errors).toBeUndefined();
    const first = firstRes.body.data.createEmploymentPolicy;
    expect(first.version).toBe(1);
    expect(first.policyGroupId).toBe(first.id);
    expect(first.effectiveTo).toBeNull();

    const secondRes = await gql(
      `mutation($input: CreateEmploymentPolicyInput!) {
        createEmploymentPolicy(input: $input) { id policyGroupId version effectiveTo }
      }`,
      {
        input: {
          policyGroupId: first.policyGroupId,
          policyType: 'OVERTIME_THRESHOLD',
          orgUnitId,
          definition: { dailyThresholdHours: 10 },
          effectiveFrom: '2025-06-01T00:00:00.000Z',
        },
      },
    ).expect(200);
    const second = secondRes.body.data.createEmploymentPolicy;
    expect(second.policyGroupId).toBe(first.policyGroupId);
    expect(second.version).toBe(2);
    expect(second.effectiveTo).toBeNull();

    // The active-as-of query: before June 1st sees v1, on/after sees v2.
    const beforeRes = await gql(
      `query($g: ID!, $asOf: DateTime!) { employmentPolicy(policyGroupId: $g, asOf: $asOf) { version } }`,
      { g: first.policyGroupId, asOf: '2025-03-01T00:00:00.000Z' },
    ).expect(200);
    expect(beforeRes.body.data.employmentPolicy.version).toBe(1);

    const afterRes = await gql(
      `query($g: ID!, $asOf: DateTime!) { employmentPolicy(policyGroupId: $g, asOf: $asOf) { version } }`,
      { g: first.policyGroupId, asOf: '2025-07-01T00:00:00.000Z' },
    ).expect(200);
    expect(afterRes.body.data.employmentPolicy.version).toBe(2);

    const listRes = await gql(
      `query($orgUnitId: ID) { employmentPolicies(orgUnitId: $orgUnitId) { policyGroupId version } }`,
      {
        orgUnitId,
      },
    ).expect(200);
    const versionsForGroup = (
      listRes.body.data.employmentPolicies as { policyGroupId: string; version: number }[]
    ).filter((p) => p.policyGroupId === first.policyGroupId);
    expect(versionsForGroup).toHaveLength(1);
    expect(versionsForGroup[0].version).toBe(2);
  });

  it('createEmploymentPolicy with a bad orgUnitId returns NOT_FOUND', async () => {
    const res = await gql(
      `mutation($input: CreateEmploymentPolicyInput!) { createEmploymentPolicy(input: $input) { id } }`,
      {
        input: {
          policyType: 'REST_PERIOD_MINIMUM',
          orgUnitId: uuidv4(),
          definition: { minMinutes: 30 },
          effectiveFrom: '2025-01-01T00:00:00.000Z',
        },
      },
    ).expect(200);
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});
