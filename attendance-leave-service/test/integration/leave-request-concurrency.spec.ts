import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { entities, LeaveBalance, LeaveRequest, LeaveType } from '../../src/database/entities';
import { ConfigService } from '@nestjs/config';
import { LeaveRequestService } from '../../src/leave/leave-request.service';
import { LeaveConflictCheckService } from '../../src/leave/leave-conflict-check.service';
import { LeaveApprovalQueueService } from '../../src/leave/bullmq/leave-approval-queue.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { RequestLeaveDto } from '../../src/leave/dto/request-leave.dto';
import { InsufficientLeaveBalanceError } from '../../src/common/errors/insufficient-leave-balance.error';
import { LeaveRequestOverlapError } from '../../src/common/errors/leave-request-overlap.error';

dotenv.config();

/**
 * §6's dedicated concurrency test for §2.2 rule 1 - the "specific double-
 * booking bug class" the module prompt names directly. Requires a reachable
 * Postgres with the Phase 1-3 migrations already applied
 * (`npm run migration:run`). Same fixture-seeding-via-migrator pattern as
 * root's own `test/integration/rls-isolation.spec.ts`: this module's own
 * mutation surface has no `createLeaveBalance`/`LeaveType` endpoint yet
 * (Phase 3 design doc's explicit assumption 3), so fixtures are seeded
 * directly via the migrator role, which owns the tables and bypasses RLS.
 *
 * The conflict-check dependency is stubbed (always "no conflict") rather
 * than pointed at a real `scheduling-service`, and the BullMQ approval
 * queue is stubbed (no-op) rather than pointed at a real Redis - this test
 * isolates and proves the `LeaveBalance` row-lock behavior specifically
 * (ADR-0074), not an end-to-end integration with Module 04 or the
 * approval-reminder queue (ADR-0077's own real-Redis verification is
 * manual, documented in the Phase 4 design doc).
 */
describe('requestLeave concurrency (§2.2 rule 1, ADR-0074)', () => {
  let appDataSource: DataSource; // agno_attendance_leave_app, same role the running application uses
  let migratorDataSource: DataSource; // fixture seeding only

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
  });

  afterAll(async () => {
    await appDataSource.destroy();
    await migratorDataSource.destroy();
  });

  it('exactly one of two genuinely concurrent overlapping requests succeeds when the balance only has room for one', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const leaveTypeId = randomUUID();
    const periodStart = '2000-01-01';
    const periodEnd = '2100-12-31';

    await migratorDataSource.getRepository(LeaveType).insert({
      id: leaveTypeId,
      tenantId,
      name: `Concurrency Test PTO ${leaveTypeId}`,
      accrualPolicyId: randomUUID(),
      requiresApproval: true,
      requiresDocumentation: false,
      maxConsecutiveDays: null,
      carryoverRules: {},
    });
    // Room for exactly one 3-day request, not two.
    await migratorDataSource.getRepository(LeaveBalance).insert({
      employeeId,
      leaveTypeId,
      periodStart,
      periodEnd,
      tenantId,
      accruedDays: '3',
      usedDays: '0',
      pendingDays: '0',
      carryoverDaysIn: '0',
      carryoverExpiryDate: null,
    });

    const metrics = new MetricsService();
    const stubConflictCheck = {
      check: async () => ({ scheduleConflict: { hasConflict: false, conflictingShiftIds: [] }, orgCoverage: null }),
    } as unknown as LeaveConflictCheckService;
    const stubApprovalQueue = { scheduleReminder: async () => undefined } as unknown as LeaveApprovalQueueService;
    const config = new ConfigService({});
    const service = new LeaveRequestService(appDataSource, stubConflictCheck, stubApprovalQueue, config, metrics);

    const dateRangeStart = futureDate(60);
    const dateRangeEnd = futureDate(62); // 3 inclusive days - exactly the whole balance

    const makeDto = (): RequestLeaveDto =>
      Object.assign(new RequestLeaveDto(), { employeeId, leaveTypeId, dateRangeStart, dateRangeEnd });

    const results = await Promise.allSettled([
      service.requestLeave(tenantId, makeDto()),
      service.requestLeave(tenantId, makeDto()),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<LeaveRequest> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InsufficientLeaveBalanceError);

    // The row itself, not just the two promises' outcomes - proves the lock
    // actually serialized the writes rather than the second request racing
    // in with a stale read.
    const balanceRow = await migratorDataSource
      .getRepository(LeaveBalance)
      .findOneByOrFail({ employeeId, leaveTypeId, periodStart, periodEnd });
    expect(Number(balanceRow.pendingDays)).toBe(3);

    const requestCount = await migratorDataSource.getRepository(LeaveRequest).countBy({ employeeId, leaveTypeId });
    expect(requestCount).toBe(1);
  });

  it('GAP-09 fix: a second, sequential request for overlapping dates is rejected even with ample balance and no concurrency involved (real EXCLUDE constraint, not just a mock)', async () => {
    const tenantId = randomUUID();
    const employeeId = randomUUID();
    const leaveTypeId = randomUUID();
    const periodStart = '2000-01-01';
    const periodEnd = '2100-12-31';

    await migratorDataSource.getRepository(LeaveType).insert({
      id: leaveTypeId,
      tenantId,
      name: `Overlap Test PTO ${leaveTypeId}`,
      accrualPolicyId: randomUUID(),
      requiresApproval: true,
      requiresDocumentation: false,
      maxConsecutiveDays: null,
      carryoverRules: {},
    });
    // Deliberately generous - plenty of room for both requests on balance
    // alone, so a rejection here can only be the overlap constraint, not
    // InsufficientLeaveBalanceError masking it.
    await migratorDataSource.getRepository(LeaveBalance).insert({
      employeeId,
      leaveTypeId,
      periodStart,
      periodEnd,
      tenantId,
      accruedDays: '30',
      usedDays: '0',
      pendingDays: '0',
      carryoverDaysIn: '0',
      carryoverExpiryDate: null,
    });

    const metrics = new MetricsService();
    const stubConflictCheck = {
      check: async () => ({ scheduleConflict: { hasConflict: false, conflictingShiftIds: [] }, orgCoverage: null }),
    } as unknown as LeaveConflictCheckService;
    const stubApprovalQueue = { scheduleReminder: async () => undefined } as unknown as LeaveApprovalQueueService;
    const config = new ConfigService({});
    const service = new LeaveRequestService(appDataSource, stubConflictCheck, stubApprovalQueue, config, metrics);

    const first = await service.requestLeave(
      tenantId,
      Object.assign(new RequestLeaveDto(), {
        employeeId,
        leaveTypeId,
        dateRangeStart: futureDate(90),
        dateRangeEnd: futureDate(94),
      }),
    );
    expect(first.status).toBe('pending');

    // Overlaps the first request's [90, 94] window at day 92 - fully
    // sequential, no race, plenty of balance left (27 of 30 days).
    await expect(
      service.requestLeave(
        tenantId,
        Object.assign(new RequestLeaveDto(), {
          employeeId,
          leaveTypeId,
          dateRangeStart: futureDate(92),
          dateRangeEnd: futureDate(96),
        }),
      ),
    ).rejects.toBeInstanceOf(LeaveRequestOverlapError);

    // A third, genuinely non-overlapping request still succeeds - the
    // constraint blocks overlaps specifically, not all subsequent requests
    // for this employee.
    const third = await service.requestLeave(
      tenantId,
      Object.assign(new RequestLeaveDto(), {
        employeeId,
        leaveTypeId,
        dateRangeStart: futureDate(120),
        dateRangeEnd: futureDate(122),
      }),
    );
    expect(third.status).toBe('pending');

    const requestCount = await migratorDataSource.getRepository(LeaveRequest).countBy({ employeeId, leaveTypeId });
    expect(requestCount).toBe(2);

    // The failed insert must not have left `pending_days` incremented -
    // proves the EXCLUDE violation rolled back the whole transaction
    // (increment + insert), not just the insert.
    const balanceRow = await migratorDataSource
      .getRepository(LeaveBalance)
      .findOneByOrFail({ employeeId, leaveTypeId, periodStart, periodEnd });
    expect(Number(balanceRow.pendingDays)).toBe(8); // 5 days (first) + 3 days (third), not 5+5+3
  });
});

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
