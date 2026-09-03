import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { entities, LeaveBalance, LeaveType } from '../../src/database/entities';
import { LeaveTypeService } from '../../src/leave/leave-type.service';
import { AccrualPolicyService } from '../../src/leave/accrual-policy.service';
import { AccrualFrequency } from '../../src/leave/entities/accrual-frequency.enum';
import { LeaveTypeNotFoundError } from '../../src/common/errors/leave-type-not-found.error';
import { LeaveTypeInUseError } from '../../src/common/errors/leave-type-in-use.error';

dotenv.config();

/**
 * User Management "Time Off" screen gap-fix — `LeaveType` previously had no
 * CRUD surface at all. Requires a reachable Postgres with migrations
 * applied (`npm run migration:run`). Same real-DataSource-via-agno_attendance_leave_app
 * pattern as `leave-request-concurrency.spec.ts`; fixtures needing to
 * bypass RLS (the cross-tenant read in the isolation test) use the
 * migrator role directly.
 */
describe('LeaveTypeService', () => {
  let appDataSource: DataSource;
  let migratorDataSource: DataSource;
  let service: LeaveTypeService;
  let accrualPolicyService: AccrualPolicyService;

  beforeAll(async () => {
    appDataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'agno_attendance_leave_app',
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

    accrualPolicyService = new AccrualPolicyService(appDataSource);
    service = new LeaveTypeService(appDataSource, accrualPolicyService);
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('creates, updates only the provided field, and deletes a leave type', async () => {
    const tenantId = randomUUID();
    const accrualPolicy = await accrualPolicyService.create(tenantId, {
      name: 'Standard PTO accrual',
      accrualRatePerPeriod: 1.5,
      accrualFrequency: AccrualFrequency.MONTHLY,
    });

    const created = await service.create(tenantId, {
      name: 'Sabbatical',
      accrualPolicyId: accrualPolicy.id,
    } as never);
    expect(created.requiresApproval).toBe(true);
    expect(created.requiresDocumentation).toBe(false);

    const updated = await service.update(tenantId, created.id, { maxConsecutiveDays: 30 } as never);
    expect(updated.maxConsecutiveDays).toBe(30);
    expect(updated.name).toBe('Sabbatical');

    await service.delete(tenantId, created.id);
    await expect(service.findById(tenantId, created.id)).rejects.toBeInstanceOf(LeaveTypeNotFoundError);
  });

  it('404s on an unknown id', async () => {
    await expect(service.findById(randomUUID(), randomUUID())).rejects.toBeInstanceOf(LeaveTypeNotFoundError);
  });

  it('refuses to delete a leave type still referenced by a leave balance', async () => {
    const tenantId = randomUUID();
    const leaveTypeId = randomUUID();
    const employeeId = randomUUID();

    await migratorDataSource.getRepository(LeaveType).insert({
      id: leaveTypeId,
      tenantId,
      name: `In-use PTO ${leaveTypeId}`,
      accrualPolicyId: randomUUID(),
      requiresApproval: true,
      requiresDocumentation: false,
      maxConsecutiveDays: null,
      carryoverRules: {},
    });
    await migratorDataSource.getRepository(LeaveBalance).insert({
      employeeId,
      leaveTypeId,
      periodStart: '2000-01-01',
      periodEnd: '2100-12-31',
      tenantId,
      accruedDays: '0',
      usedDays: '0',
      pendingDays: '0',
      carryoverDaysIn: '0',
      carryoverExpiryDate: null,
      lastAccruedAt: null,
    });

    await expect(service.delete(tenantId, leaveTypeId)).rejects.toBeInstanceOf(LeaveTypeInUseError);
  });
});
