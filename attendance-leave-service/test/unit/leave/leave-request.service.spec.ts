import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { LeaveRequestService } from '../../../src/leave/leave-request.service';
import { LeaveConflictCheckService } from '../../../src/leave/leave-conflict-check.service';
import { LeaveApprovalQueueService } from '../../../src/leave/bullmq/leave-approval-queue.service';
import { LeaveBalance } from '../../../src/leave/entities/leave-balance.entity';
import { LeaveRequest } from '../../../src/leave/entities/leave-request.entity';
import { LeaveType } from '../../../src/leave/entities/leave-type.entity';
import { RequestLeaveDto } from '../../../src/leave/dto/request-leave.dto';
import { SubmitBackdatedLeaveDto } from '../../../src/leave/dto/submit-backdated-leave.dto';
import { InvalidLeaveRequestError } from '../../../src/common/errors/invalid-leave-request.error';
import { BackdatedLeaveNotSupportedError } from '../../../src/common/errors/backdated-leave-not-supported.error';
import { NotActuallyBackdatedError } from '../../../src/common/errors/not-actually-backdated.error';
import { LeaveBalanceNotFoundError } from '../../../src/common/errors/leave-balance-not-found.error';
import { InsufficientLeaveBalanceError } from '../../../src/common/errors/insufficient-leave-balance.error';
import { LeaveRequestOverlapError } from '../../../src/common/errors/leave-request-overlap.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

function balance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    employeeId: 'emp-1',
    leaveTypeId: 'type-1',
    periodStart: '2000-01-01',
    periodEnd: '2100-12-31',
    tenantId: 'tenant-1',
    accruedDays: '10',
    usedDays: '0',
    pendingDays: '0',
    carryoverDaysIn: '0',
    carryoverExpiryDate: null,
    carryoverApplied: false,
    lastAccruedAt: null,
    ...overrides,
  };
}

function leaveType(overrides: Partial<LeaveType> = {}): LeaveType {
  return {
    id: 'type-1',
    tenantId: 'tenant-1',
    name: 'PTO',
    accrualPolicyId: 'policy-1',
    requiresApproval: true,
    requiresDocumentation: false,
    maxConsecutiveDays: null,
    carryoverRules: {},
    ...overrides,
  };
}

/** `YYYY-MM-DD`, `daysFromNow` days ahead of the real current date - never a hardcoded date, which would silently become "backdated" as time passes. */
function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD`, `daysAgo` days before the real current date - the `submitBackdatedLeave` mirror of `futureDate`. */
function pastDate(daysAgo: number): string {
  return futureDate(-daysAgo);
}

describe('LeaveRequestService', () => {
  let queryBuilder: { setLock: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let manager: jest.Mocked<
    Pick<EntityManager, 'createQueryBuilder' | 'increment' | 'insert' | 'findOneByOrFail' | 'query'>
  >;
  let dataSource: Pick<DataSource, 'transaction'>;
  let conflictCheck: jest.Mocked<Pick<LeaveConflictCheckService, 'check'>>;
  let approvalQueue: jest.Mocked<Pick<LeaveApprovalQueueService, 'scheduleReminder'>>;
  let config: ConfigService;
  let metrics: MetricsService;
  let service: LeaveRequestService;
  let currentLeaveType: LeaveType;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const validDto: RequestLeaveDto = Object.assign(new RequestLeaveDto(), {
    employeeId: 'emp-1',
    leaveTypeId: 'type-1',
    dateRangeStart: futureDate(30),
    dateRangeEnd: futureDate(32), // 3 inclusive days
  });

  beforeEach(() => {
    currentLeaveType = leaveType(); // requiresApproval: true by default
    queryBuilder = { setLock: jest.fn(), where: jest.fn(), andWhere: jest.fn(), getOne: jest.fn() };
    queryBuilder.setLock.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.andWhere.mockReturnValue(queryBuilder);

    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      increment: jest.fn().mockResolvedValue({}),
      insert: jest.fn().mockResolvedValue({}),
      // LeaveType lookups resolve to the test's fixture; LeaveRequest
      // lookups (the final re-read after insert) resolve to a minimal
      // stand-in - individual tests override this via mockResolvedValueOnce
      // where the returned id/shape actually matters.
      findOneByOrFail: jest.fn(async (entity: unknown, _where: unknown) =>
        entity === LeaveType ? currentLeaveType : ({ id: 'new-request-id' } as LeaveRequest),
      ) as unknown as jest.MockedFunction<EntityManager['findOneByOrFail']>,
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    conflictCheck = { check: jest.fn() };
    approvalQueue = { scheduleReminder: jest.fn().mockResolvedValue(undefined) };
    config = new ConfigService({ LEAVE_APPROVAL_REMINDER_DELAY_MS: 600_000 });
    metrics = new MetricsService();
    service = new LeaveRequestService(
      dataSource as DataSource,
      conflictCheck as unknown as LeaveConflictCheckService,
      approvalQueue as unknown as LeaveApprovalQueueService,
      config,
      metrics,
    );
  });

  it('rejects when dateRangeEnd is before dateRangeStart, without calling the conflict check', async () => {
    const dto = Object.assign(new RequestLeaveDto(), {
      ...validDto,
      dateRangeStart: futureDate(35),
      dateRangeEnd: futureDate(30),
    });
    await expect(service.requestLeave(tenantId, dto)).rejects.toThrow(InvalidLeaveRequestError);
    expect(conflictCheck.check).not.toHaveBeenCalled();
  });

  it('rejects a backdated dateRangeStart, without calling the conflict check (§5.1: use submitBackdatedLeave instead)', async () => {
    const dto = Object.assign(new RequestLeaveDto(), {
      ...validDto,
      dateRangeStart: futureDate(-10),
      dateRangeEnd: futureDate(-9),
    });
    await expect(service.requestLeave(tenantId, dto)).rejects.toThrow(BackdatedLeaveNotSupportedError);
    expect(conflictCheck.check).not.toHaveBeenCalled();
  });

  it('rejects when no LeaveBalance row covers the request, without reserving or inserting anything', async () => {
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow(LeaveBalanceNotFoundError);
    expect(manager.increment).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('rejects when requestedDays exceeds availableDays, without reserving or inserting anything', async () => {
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '2', usedDays: '0', pendingDays: '0' })); // only 2 available, request is 3 days

    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow(InsufficientLeaveBalanceError);
    expect(manager.increment).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('GAP-09 fix: converts a real Postgres exclusion-violation (23P01) on insert into LeaveRequestOverlapError, not a raw 500', async () => {
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));
    manager.insert.mockRejectedValue(
      Object.assign(new Error('conflicting key value violates exclusion constraint'), { code: '23P01' }),
    );

    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow(LeaveRequestOverlapError);
  });

  it('a non-exclusion-violation insert failure still propagates as-is (not misclassified as an overlap)', async () => {
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));
    manager.insert.mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));

    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow('connection reset');
    await expect(service.requestLeave(tenantId, validDto)).rejects.not.toBeInstanceOf(LeaveRequestOverlapError);
  });

  it('accepts a valid request (requiresApproval: true): reserves pending_days, inserts the LeaveRequest with a populated conflict_flags and approvalChainId, and schedules a reminder', async () => {
    const flags = { scheduleConflict: { hasConflict: true, conflictingShiftIds: ['shift-9'] }, orgCoverage: null };
    conflictCheck.check.mockResolvedValue(flags);
    queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));

    const result = await service.requestLeave(tenantId, validDto);

    expect(manager.increment).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ employeeId: 'emp-1', leaveTypeId: 'type-1' }),
      'pendingDays',
      3,
    );
    expect(manager.insert).toHaveBeenCalledWith(
      LeaveRequest,
      expect.objectContaining({
        employeeId: 'emp-1',
        leaveTypeId: 'type-1',
        status: 'pending',
        conflictFlags: flags,
        approvalChainId: expect.any(String),
      }),
    );
    expect(result).toEqual({ id: 'new-request-id' });
    expect(approvalQueue.scheduleReminder).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, leaveRequestId: 'new-request-id', approvalChainId: expect.any(String) }),
      600_000,
    );
  });

  it('accepts a valid request against a LeaveType with requiresApproval: false: goes straight to used_days, no chain, no reminder scheduled', async () => {
    currentLeaveType = leaveType({ requiresApproval: false });
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));

    await service.requestLeave(tenantId, validDto);

    expect(manager.increment).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ employeeId: 'emp-1', leaveTypeId: 'type-1' }),
      'usedDays',
      3,
    );
    expect(manager.increment).not.toHaveBeenCalledWith(
      LeaveBalance,
      expect.anything(),
      'pendingDays',
      expect.anything(),
    );
    expect(manager.insert).toHaveBeenCalledWith(
      LeaveRequest,
      expect.objectContaining({ status: 'approved', approvalChainId: null, decidedBy: null }),
    );
    expect(approvalQueue.scheduleReminder).not.toHaveBeenCalled();
  });

  it("rejects an unknown leaveTypeId as LeaveBalanceNotFoundError - the balance lookup gates leave_type_id validity, so a leave_type FK violation can never actually be reached (see LeaveRequestService.reserveAndSubmit's own doc comment)", async () => {
    conflictCheck.check.mockResolvedValue({
      scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
      orgCoverage: null,
    });
    queryBuilder.getOne.mockResolvedValue(null); // no LeaveBalance row exists for this leaveTypeId

    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow(LeaveBalanceNotFoundError);
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('never opens a transaction if the conflict check fails (fail-closed, §2.2 rule 2)', async () => {
    conflictCheck.check.mockRejectedValue(new Error('scheduling-service down'));
    await expect(service.requestLeave(tenantId, validDto)).rejects.toThrow('scheduling-service down');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  describe('submitBackdatedLeave (§5.1, Phase 6)', () => {
    const validBackdatedDto: SubmitBackdatedLeaveDto = Object.assign(new SubmitBackdatedLeaveDto(), {
      employeeId: 'emp-1',
      leaveTypeId: 'type-1',
      dateRangeStart: pastDate(10),
      dateRangeEnd: pastDate(8), // 3 inclusive days
      backdatedReason: 'Employee was hospitalized and could not submit in advance.',
    });

    it('rejects when dateRangeEnd is before dateRangeStart, without calling the conflict check', async () => {
      const dto = Object.assign(new SubmitBackdatedLeaveDto(), {
        ...validBackdatedDto,
        dateRangeStart: pastDate(8),
        dateRangeEnd: pastDate(10),
      });
      await expect(service.submitBackdatedLeave(tenantId, dto)).rejects.toThrow(InvalidLeaveRequestError);
      expect(conflictCheck.check).not.toHaveBeenCalled();
    });

    it('rejects a dateRangeStart that is not actually in the past, without calling the conflict check (the mirror image of requestLeave rejecting a past date)', async () => {
      const dto = Object.assign(new SubmitBackdatedLeaveDto(), {
        ...validBackdatedDto,
        dateRangeStart: futureDate(1),
        dateRangeEnd: futureDate(2),
      });
      await expect(service.submitBackdatedLeave(tenantId, dto)).rejects.toThrow(NotActuallyBackdatedError);
      expect(conflictCheck.check).not.toHaveBeenCalled();
    });

    it('rejects when no LeaveBalance row covers the request, without reserving or inserting anything', async () => {
      conflictCheck.check.mockResolvedValue({
        scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
        orgCoverage: null,
      });
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(service.submitBackdatedLeave(tenantId, validBackdatedDto)).rejects.toThrow(
        LeaveBalanceNotFoundError,
      );
      expect(manager.increment).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('rejects when requestedDays exceeds availableDays, without reserving or inserting anything', async () => {
      conflictCheck.check.mockResolvedValue({
        scheduleConflict: { hasConflict: false, conflictingShiftIds: [] },
        orgCoverage: null,
      });
      queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '2', usedDays: '0', pendingDays: '0' }));

      await expect(service.submitBackdatedLeave(tenantId, validBackdatedDto)).rejects.toThrow(
        InsufficientLeaveBalanceError,
      );
      expect(manager.increment).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('always reserves pending_days and inserts as pending with isBackdated/backdatedReason set, and schedules a reminder - even against a LeaveType with requiresApproval: false', async () => {
      currentLeaveType = leaveType({ requiresApproval: false });
      const flags = { scheduleConflict: { hasConflict: false, conflictingShiftIds: [] }, orgCoverage: null };
      conflictCheck.check.mockResolvedValue(flags);
      queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));

      const result = await service.submitBackdatedLeave(tenantId, validBackdatedDto);

      expect(manager.increment).toHaveBeenCalledWith(
        LeaveBalance,
        expect.objectContaining({ employeeId: 'emp-1', leaveTypeId: 'type-1' }),
        'pendingDays',
        3,
      );
      expect(manager.insert).toHaveBeenCalledWith(
        LeaveRequest,
        expect.objectContaining({
          status: 'pending',
          isBackdated: true,
          backdatedReason: validBackdatedDto.backdatedReason,
          backdatedApprovedBy: null,
          approvalChainId: expect.any(String),
          conflictFlags: flags,
        }),
      );
      expect(result).toEqual({ id: 'new-request-id' });
      expect(approvalQueue.scheduleReminder).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId, leaveRequestId: 'new-request-id', approvalChainId: expect.any(String) }),
        600_000,
      );
    });

    it('runs the same conflict check as requestLeave, not an exemption from it', async () => {
      conflictCheck.check.mockResolvedValue({
        scheduleConflict: { hasConflict: true, conflictingShiftIds: ['shift-1'] },
        orgCoverage: null,
      });
      queryBuilder.getOne.mockResolvedValue(balance({ accruedDays: '10', usedDays: '0', pendingDays: '0' }));

      await service.submitBackdatedLeave(tenantId, validBackdatedDto);

      expect(conflictCheck.check).toHaveBeenCalledWith(
        tenantId,
        'emp-1',
        validBackdatedDto.dateRangeStart,
        validBackdatedDto.dateRangeEnd,
        undefined,
      );
    });
  });
});
