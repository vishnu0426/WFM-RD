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

dotenv.config();

/**
 * Extended pay/OT/VTO limit fields + effective-dating window added to
 * `WorkRule` (item 9), exercised over the real HTTP/GraphQL surface -
 * same pattern as `skill-api-http.spec.ts`.
 */
describe('WorkRule API (GraphQL, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;

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
        name: `WorkRule API Test Tenant ${uuidv4()}`,
        tier: TenantTier.SMB,
        dataResidencyRegion: 'us-east-1',
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  const CREATE_MUTATION = `
    mutation($input: CreateWorkRuleInput!) {
      createWorkRule(input: $input) {
        id name maxConsecutiveDays minRestHours maxWeeklyHours otEligible
        minPaidHours maxOtPerDay maxOtPerWeek maxVtoPerDay maxVtoPerWeek
        requiredPayPeriodHours effectiveFrom effectiveTo
      }
    }
  `;

  const UPDATE_MUTATION = `
    mutation($input: UpdateWorkRuleInput!) {
      updateWorkRule(input: $input) {
        id name maxConsecutiveDays minRestHours maxWeeklyHours otEligible
        minPaidHours maxOtPerDay maxOtPerWeek maxVtoPerDay maxVtoPerWeek
        requiredPayPeriodHours effectiveFrom effectiveTo
      }
    }
  `;

  it('creates a WorkRule with the new pay/OT/VTO limit fields and reads them back', async () => {
    const input = {
      name: `Standard Full-Time ${uuidv4()}`,
      maxConsecutiveDays: 6,
      minRestHours: 10,
      maxWeeklyHours: 40,
      otEligible: true,
      minPaidHours: 4,
      maxOtPerDay: 2,
      maxOtPerWeek: 8,
      maxVtoPerDay: 4,
      maxVtoPerWeek: 12,
      requiredPayPeriodHours: 80,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    };

    const createRes = await gql(CREATE_MUTATION, { input }).expect(200);
    expect(createRes.body.errors).toBeUndefined();
    const created = createRes.body.data.createWorkRule;

    expect(created.minPaidHours).toBe(4);
    expect(created.maxOtPerDay).toBe(2);
    expect(created.maxOtPerWeek).toBe(8);
    expect(created.maxVtoPerDay).toBe(4);
    expect(created.maxVtoPerWeek).toBe(12);
    expect(created.requiredPayPeriodHours).toBe(80);
    expect(created.effectiveFrom).toBe('2026-01-01');
    expect(created.effectiveTo).toBe('2026-12-31');

    const readRes = await gql(
      `query($id: ID!) { workRule(id: $id) { id maxOtPerWeek effectiveFrom effectiveTo } }`,
      { id: created.id },
    ).expect(200);
    expect(readRes.body.errors).toBeUndefined();
    expect(readRes.body.data.workRule.maxOtPerWeek).toBe(8);
    expect(readRes.body.data.workRule.effectiveFrom).toBe('2026-01-01');
    expect(readRes.body.data.workRule.effectiveTo).toBe('2026-12-31');
  });

  it('updateWorkRule changes the new limit fields on an existing rule', async () => {
    const createRes = await gql(CREATE_MUTATION, {
      input: { name: `Part-Time ${uuidv4()}`, otEligible: false },
    }).expect(200);
    expect(createRes.body.errors).toBeUndefined();
    const created = createRes.body.data.createWorkRule;
    expect(created.maxOtPerDay).toBeNull();

    const updateRes = await gql(UPDATE_MUTATION, {
      input: {
        id: created.id,
        maxOtPerDay: 1.5,
        maxOtPerWeek: 5,
        maxVtoPerDay: 2,
        maxVtoPerWeek: 6,
        minPaidHours: 3,
        requiredPayPeriodHours: 40,
        effectiveFrom: '2026-03-01',
        effectiveTo: '2026-09-30',
      },
    }).expect(200);
    expect(updateRes.body.errors).toBeUndefined();
    const updated = updateRes.body.data.updateWorkRule;

    expect(updated.id).toBe(created.id);
    expect(updated.maxOtPerDay).toBe(1.5);
    expect(updated.maxOtPerWeek).toBe(5);
    expect(updated.maxVtoPerDay).toBe(2);
    expect(updated.maxVtoPerWeek).toBe(6);
    expect(updated.minPaidHours).toBe(3);
    expect(updated.requiredPayPeriodHours).toBe(40);
    expect(updated.effectiveFrom).toBe('2026-03-01');
    expect(updated.effectiveTo).toBe('2026-09-30');
    // Untouched fields survive the partial update unchanged.
    expect(updated.name).toBe(created.name);
    expect(updated.otEligible).toBe(created.otEligible);
  });
});
