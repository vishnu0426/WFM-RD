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

/** Phase 6: bulk HRIS import (dry-run, feature-flagged commit, idempotency) + transactional outbox events. */
describe('Bulk import + eventing (REST + GraphQL, end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let orgUnitId: string;
  let existingEmployeeNumber: string;

  const gql = (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/graphql').set('x-tenant-id', tenantId).send({ query, variables });

  const waitForJob = async (
    jobId: string,
    timeoutMs = 10000,
  ): Promise<{ status: string; result: unknown; error: string | null }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('x-tenant-id', tenantId).expect(200);
      if (res.body.status === 'completed' || res.body.status === 'failed') {
        return res.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`job ${jobId} did not complete within ${timeoutMs}ms`);
  };

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
        name: `Bulk Import Test Tenant ${uuidv4()}`,
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
        name: 'Bulk Import Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitId = orgUnit.id;

    existingEmployeeNumber = `EXISTING-${uuidv4()}`;
    await migratorDataSource.getRepository(Employee).save(
      migratorDataSource.getRepository(Employee).create({
        id: uuidv4(),
        tenantId,
        userId: null,
        orgUnitId,
        employeeNumber: existingEmployeeNumber,
        employmentType: EmploymentType.PART_TIME,
        contractHoursPerWeek: '20.00',
        hireDate: '2023-01-01',
        terminationDate: null,
        costCenter: 'CC-OLD',
        managerEmployeeId: null,
        status: EmployeeStatus.ACTIVE,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('dry-run reports creates/updates/conflicts and commits nothing', async () => {
    const newEmployeeNumber = `NEW-${uuidv4()}`;
    const res = await request(app.getHttpServer())
      .post('/v1/employees/bulk-import')
      .set('x-tenant-id', tenantId)
      .send({
        dryRun: true,
        records: [
          {
            employeeNumber: newEmployeeNumber,
            orgUnitId,
            employmentType: 'full_time',
            contractHoursPerWeek: 40,
            hireDate: '2026-01-01',
          },
          {
            employeeNumber: existingEmployeeNumber,
            orgUnitId,
            employmentType: 'full_time',
            contractHoursPerWeek: 40,
            hireDate: '2023-01-01',
            costCenter: 'CC-NEW',
          },
          {
            employeeNumber: `CONFLICT-${uuidv4()}`,
            orgUnitId: uuidv4(),
            employmentType: 'full_time',
            contractHoursPerWeek: 40,
            hireDate: '2026-01-01',
          },
        ],
      })
      .expect(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.dryRun).toBe(true);

    const finished = await waitForJob(res.body.id);
    expect(finished.status).toBe('completed');
    const result = finished.result as {
      creates: { employeeNumber: string }[];
      updates: { employeeNumber: string }[];
      conflicts: { employeeNumber: string }[];
    };
    expect(result.creates.map((c) => c.employeeNumber)).toContain(newEmployeeNumber);
    expect(result.updates.map((u) => u.employeeNumber)).toContain(existingEmployeeNumber);
    expect(result.conflicts).toHaveLength(1);

    const stillMissing = await migratorDataSource
      .getRepository(Employee)
      .findOne({ where: { tenantId, employeeNumber: newEmployeeNumber } });
    expect(stillMissing).toBeNull();
  });

  it('non-dry-run import fails closed when the destructive feature flag is disabled', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/employees/bulk-import')
      .set('x-tenant-id', tenantId)
      .send({
        dryRun: false,
        records: [
          {
            employeeNumber: `GATED-${uuidv4()}`,
            orgUnitId,
            employmentType: 'full_time',
            contractHoursPerWeek: 40,
            hireDate: '2026-01-01',
          },
        ],
      })
      .expect(202);

    const finished = await waitForJob(res.body.id);
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/bulk_import_destructive/);
  });

  it('enabling the feature flag allows a non-dry-run import to actually commit, and repeated Idempotency-Key does not re-run it', async () => {
    const flagRes = await gql(
      `mutation { setFeatureFlag(flagKey: "bulk_import_destructive", enabled: true) { flagKey enabled } }`,
    ).expect(200);
    expect(flagRes.body.data.setFeatureFlag.enabled).toBe(true);

    const newEmployeeNumber = `COMMITTED-${uuidv4()}`;
    const idempotencyKey = uuidv4();

    const firstRes = await request(app.getHttpServer())
      .post('/v1/employees/bulk-import')
      .set('x-tenant-id', tenantId)
      .set('idempotency-key', idempotencyKey)
      .send({
        dryRun: false,
        records: [
          {
            employeeNumber: newEmployeeNumber,
            orgUnitId,
            employmentType: 'full_time',
            contractHoursPerWeek: 40,
            hireDate: '2026-01-01',
          },
        ],
      })
      .expect(202);
    const jobId = firstRes.body.id;

    const finished = await waitForJob(jobId);
    expect(finished.status).toBe('completed');
    const result = finished.result as { committed: { created: number; updated: number } };
    expect(result.committed.created).toBe(1);

    const committed = await migratorDataSource
      .getRepository(Employee)
      .findOne({ where: { tenantId, employeeNumber: newEmployeeNumber } });
    expect(committed).not.toBeNull();

    const secondRes = await request(app.getHttpServer())
      .post('/v1/employees/bulk-import')
      .set('x-tenant-id', tenantId)
      .set('idempotency-key', idempotencyKey)
      .send({ dryRun: false, records: [] })
      .expect(202);
    expect(secondRes.body.id).toBe(jobId);
  });

  it('creating an employee writes an EmployeeChanged outbox event transactionally', async () => {
    const employeeNumber = `EVT-${uuidv4()}`;
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId,
        employeeNumber,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2026-01-01',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    const events = await migratorDataSource.query(
      `SELECT payload FROM org.outbox_events WHERE tenant_id = $1 AND subject = 'agno.org.employee.changed.v1' AND payload->>'employeeId' = $2`,
      [tenantId, employeeId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.eventType).toBe('created');
  });

  it('transferring an employee writes a "transferred" EmployeeChanged event', async () => {
    const employeeNumber = `EVT-XFER-${uuidv4()}`;
    const createRes = await gql(`mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id } }`, {
      input: {
        orgUnitId,
        employeeNumber,
        employmentType: 'FULL_TIME',
        contractHoursPerWeek: 40,
        hireDate: '2026-01-01',
      },
    }).expect(200);
    const employeeId = createRes.body.data.createEmployee.id;

    const otherOrgUnit = await migratorDataSource.getRepository(OrgUnit).save(
      migratorDataSource.getRepository(OrgUnit).create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: `Transfer Target ${uuidv4()}`,
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );

    await gql(
      `mutation($employeeId: ID!, $newOrgUnitId: ID!) { transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId) { id } }`,
      { employeeId, newOrgUnitId: otherOrgUnit.id },
    ).expect(200);

    const events = await migratorDataSource.query(
      `SELECT payload FROM org.outbox_events WHERE tenant_id = $1 AND subject = 'agno.org.employee.changed.v1' AND payload->>'employeeId' = $2 ORDER BY created_at ASC`,
      [tenantId, employeeId],
    );
    expect(events).toHaveLength(2);
    expect(events[0].payload.eventType).toBe('created');
    expect(events[1].payload.eventType).toBe('transferred');
  });
});
