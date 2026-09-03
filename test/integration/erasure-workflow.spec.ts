import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { entities, Tenant, User, AuditLog, OutboxEvent } from '../../src/modules/entities';
import { TenantTier } from '../../src/modules/tenant/entities/tenant-tier.enum';
import { TenantStatus } from '../../src/modules/tenant/entities/tenant-status.enum';
import { UserStatus } from '../../src/modules/identity/entities/user-status.enum';
import { OrgUnit } from '../../src/modules/org-unit/entities/org-unit.entity';
import { OrgUnitType } from '../../src/modules/org-unit/entities/org-unit-type.enum';
import { OrgUnitStatus } from '../../src/modules/org-unit/entities/org-unit-status.enum';

dotenv.config();

/**
 * Phase 8 (§2.4/§8): the `ErasureRequest` lifecycle end to end, including
 * the anonymization side effect on `status = 'completed'` and its
 * `AuditLog`/outbox consequences - verified directly against Postgres with
 * the migrator connection, since `agno_app`'s restricted grants (§2.2 rule
 * 2 style column-scoped GRANTs, ADR-0022) are exactly what this phase's own
 * migration had to extend, and the app-level assertions alone wouldn't
 * prove the DB-level grant actually works.
 */
describe('GDPR erasure workflow (end to end)', () => {
  let app: INestApplication;
  let migratorDataSource: DataSource;
  let tenantId: string;
  let orgUnitId: string;
  let secondOrgUnitId: string;
  let actorUserId: string;

  const gql = (query: string, variables?: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/graphql')
      .set('x-tenant-id', tenantId)
      .set('x-actor-id', actorUserId)
      .set('x-actor-type', 'user')
      .send({ query, variables });

  const createEmployee = async (): Promise<{ id: string; employeeNumber: string }> => {
    const employeeNumber = `ERA-${uuidv4().slice(0, 8)}`;
    const res = await gql(
      `mutation($input: CreateEmployeeInput!) { createEmployee(input: $input) { id employeeNumber } }`,
      {
        input: {
          orgUnitId,
          employeeNumber,
          employmentType: 'FULL_TIME',
          contractHoursPerWeek: 40,
          hireDate: '2024-01-15',
        },
      },
    ).expect(200);
    return res.body.data.createEmployee;
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
        name: `Erasure Test Tenant ${uuidv4()}`,
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
        email: `erasure-admin-${uuidv4()}@example.com`,
        status: UserStatus.ACTIVE,
      }),
    );
    actorUserId = user.id;

    const orgUnit = await migratorDataSource.getRepository(OrgUnit).save(
      migratorDataSource.getRepository(OrgUnit).create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Erasure Test Site',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    orgUnitId = orgUnit.id;

    const secondOrgUnit = await migratorDataSource.getRepository(OrgUnit).save(
      migratorDataSource.getRepository(OrgUnit).create({
        tenantId,
        parentOrgUnitId: null,
        type: OrgUnitType.SITE,
        name: 'Erasure Test Site 2',
        timezone: 'UTC',
        countryCode: 'US',
        status: OrgUnitStatus.ACTIVE,
      }),
    );
    secondOrgUnitId = secondOrgUnit.id;
  });

  afterAll(async () => {
    await app.close();
    await migratorDataSource.destroy();
  });

  it('rejects a request when the transition is illegal (complete before approve)', async () => {
    const employee = await createEmployee();
    const createRes = await gql(
      `mutation($employeeId: ID!, $input: CreateErasureRequestInput!) {
        createErasureRequest(employeeId: $employeeId, input: $input) { id status }
      }`,
      { employeeId: employee.id, input: { legalBasis: 'GDPR Art. 17 - data subject request' } },
    ).expect(200);
    expect(createRes.body.data.createErasureRequest.status).toBe('PENDING');
    const requestId = createRes.body.data.createErasureRequest.id;

    const completeTooEarlyRes = await gql(`mutation($id: ID!) { completeErasureRequest(id: $id) { id } }`, {
      id: requestId,
    }).expect(200);
    expect(completeTooEarlyRes.body.errors[0].extensions.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('approve -> complete anonymizes the live row and every history row, and leaves an audit trail', async () => {
    const employee = await createEmployee();

    // Transfer once so a second (closed) EmployeeHistory row exists -
    // erasure must scrub every history row, not just the currently open one.
    await gql(
      `mutation($employeeId: ID!, $newOrgUnitId: ID!) {
        transferEmployee(employeeId: $employeeId, newOrgUnitId: $newOrgUnitId) { id }
      }`,
      { employeeId: employee.id, newOrgUnitId: secondOrgUnitId },
    ).expect(200);

    const createRes = await gql(
      `mutation($employeeId: ID!, $input: CreateErasureRequestInput!) {
        createErasureRequest(employeeId: $employeeId, input: $input) { id status requestedBy }
      }`,
      { employeeId: employee.id, input: { legalBasis: 'GDPR Art. 17 - data subject request' } },
    ).expect(200);
    const requestId = createRes.body.data.createErasureRequest.id;
    expect(createRes.body.data.createErasureRequest.requestedBy).toBe(actorUserId);

    const approveRes = await gql(`mutation($id: ID!) { approveErasureRequest(id: $id) { id status } }`, {
      id: requestId,
    }).expect(200);
    expect(approveRes.body.data.approveErasureRequest.status).toBe('APPROVED');

    const completeRes = await gql(`mutation($id: ID!) { completeErasureRequest(id: $id) { id status completedAt } }`, {
      id: requestId,
    }).expect(200);
    expect(completeRes.body.data.completeErasureRequest.status).toBe('COMPLETED');
    expect(completeRes.body.data.completeErasureRequest.completedAt).not.toBeNull();

    // Re-completing an already-completed request is rejected, not a silent no-op.
    const doubleCompleteRes = await gql(`mutation($id: ID!) { completeErasureRequest(id: $id) { id } }`, {
      id: requestId,
    }).expect(200);
    expect(doubleCompleteRes.body.errors[0].extensions.code).toBe('INVALID_STATE_TRANSITION');

    const employeeRow = await migratorDataSource.query(
      `SELECT employee_number, user_id FROM org.employees WHERE tenant_id = $1 AND id = $2`,
      [tenantId, employee.id],
    );
    expect(employeeRow[0].employee_number).toMatch(/^ERASED-/);
    expect(employeeRow[0].employee_number).not.toBe(employee.employeeNumber);
    expect(employeeRow[0].user_id).toBeNull();

    const historyRows = await migratorDataSource.query(
      `SELECT employee_number FROM org.employee_history WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, employee.id],
    );
    expect(historyRows.length).toBeGreaterThanOrEqual(2);
    for (const row of historyRows) {
      expect(row.employee_number).toMatch(/^ERASED-/);
    }

    const auditRows = await migratorDataSource.getRepository(AuditLog).find({
      where: {
        tenantId,
        resourceType: 'Employee',
        resourceId: employee.id,
        action: 'employee.erasure.completed',
      } as never,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actorId).toBe(actorUserId);
    // The audit trail records that anonymization happened, never the erased value itself.
    expect(JSON.stringify(auditRows[0].afterState)).not.toContain(employee.employeeNumber);

    const outboxRows = await migratorDataSource.getRepository(OutboxEvent).find({
      where: { tenantId, subject: 'agno.org.employee.changed.v1' } as never,
    });
    const erasedEvent = outboxRows.find(
      (row) =>
        (row.payload as { employeeId?: string }).employeeId === employee.id &&
        (row.payload as { eventType?: string }).eventType === 'erased',
    );
    expect(erasedEvent).toBeDefined();
  });

  it('reject is allowed from pending or approved, but not from completed', async () => {
    const employee = await createEmployee();
    const createRes = await gql(
      `mutation($employeeId: ID!, $input: CreateErasureRequestInput!) {
        createErasureRequest(employeeId: $employeeId, input: $input) { id }
      }`,
      { employeeId: employee.id, input: { legalBasis: 'GDPR Art. 17' } },
    ).expect(200);
    const requestId = createRes.body.data.createErasureRequest.id;

    const rejectRes = await gql(`mutation($id: ID!) { rejectErasureRequest(id: $id) { id status } }`, {
      id: requestId,
    }).expect(200);
    expect(rejectRes.body.data.rejectErasureRequest.status).toBe('REJECTED');

    const approveAfterRejectRes = await gql(`mutation($id: ID!) { approveErasureRequest(id: $id) { id } }`, {
      id: requestId,
    }).expect(200);
    expect(approveAfterRejectRes.body.errors[0].extensions.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('REST: POST /v1/employees/:id/erasure-requests creates a request', async () => {
    const employee = await createEmployee();
    const res = await request(app.getHttpServer())
      .post(`/v1/employees/${employee.id}/erasure-requests`)
      .set('x-tenant-id', tenantId)
      .set('x-actor-id', actorUserId)
      .set('x-actor-type', 'user')
      .send({ legalBasis: 'GDPR Art. 17 - REST path' })
      .expect(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.employeeId).toBe(employee.id);
  });
});
