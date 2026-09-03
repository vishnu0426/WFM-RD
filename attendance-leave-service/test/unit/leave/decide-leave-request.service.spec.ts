import { DataSource, EntityManager } from 'typeorm';
import {
  BACKDATED_LEAVE_APPROVE_PERMISSION,
  DecideLeaveRequestService,
} from '../../../src/leave/decide-leave-request.service';
import { LeaveApprovalQueueService } from '../../../src/leave/bullmq/leave-approval-queue.service';
import { LeaveBalance } from '../../../src/leave/entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from '../../../src/leave/entities/leave-request.entity';
import { DecideLeaveRequestDto } from '../../../src/leave/dto/decide-leave-request.dto';
import { LeaveRequestNotFoundError } from '../../../src/common/errors/leave-request-not-found.error';
import { LeaveRequestAlreadyDecidedError } from '../../../src/common/errors/leave-request-already-decided.error';
import { InsufficientPermissionError } from '../../../src/common/errors/insufficient-permission.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AttendanceLeaveNatsClientService } from '../../../src/nats/nats-client.service';
import { ATTENDANCE_LEAVE_SUBJECTS } from '../../../src/nats/subjects';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';

function pendingRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    tenantId: 'tenant-1',
    employeeId: 'emp-1',
    leaveTypeId: 'type-1',
    dateRangeStart: '2026-06-01',
    dateRangeEnd: '2026-06-03', // 3 inclusive days
    status: LeaveRequestStatus.PENDING,
    approvalChainId: 'chain-1',
    requestedAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    conflictFlags: {},
    isBackdated: false,
    backdatedReason: null,
    backdatedApprovedBy: null,
    decisionReason: null,
    ...overrides,
  };
}

function balance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    employeeId: 'emp-1',
    leaveTypeId: 'type-1',
    periodStart: '2000-01-01',
    periodEnd: '2100-12-31',
    tenantId: 'tenant-1',
    accruedDays: '10',
    usedDays: '0',
    pendingDays: '3',
    carryoverDaysIn: '0',
    carryoverExpiryDate: null,
    carryoverApplied: false,
    lastAccruedAt: null,
    ...overrides,
  };
}

describe('DecideLeaveRequestService', () => {
  let requestQueryBuilder: { setLock: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let balanceQueryBuilder: { setLock: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock };
  let manager: jest.Mocked<
    Pick<EntityManager, 'createQueryBuilder' | 'increment' | 'decrement' | 'update' | 'findOneByOrFail' | 'query'>
  >;
  let dataSource: Pick<DataSource, 'transaction'>;
  let approvalQueue: jest.Mocked<Pick<LeaveApprovalQueueService, 'cancelReminder'>>;
  let natsClient: jest.Mocked<Pick<AttendanceLeaveNatsClientService, 'publish'>>;
  let auditClient: jest.Mocked<Pick<AuditGrpcClientService, 'recordEvent'>>;
  let metrics: MetricsService;
  let service: DecideLeaveRequestService;

  const tenantId = 'tenant-1';
  const approveDto: DecideLeaveRequestDto = Object.assign(new DecideLeaveRequestDto(), {
    decision: LeaveRequestStatus.APPROVED,
    decidedBy: 'manager-1',
  });
  const rejectDto: DecideLeaveRequestDto = Object.assign(new DecideLeaveRequestDto(), {
    decision: LeaveRequestStatus.REJECTED,
    decidedBy: 'manager-1',
    reason: 'Coverage gap on the requested dates.',
  });
  const approveWithPermissionDto: DecideLeaveRequestDto = Object.assign(new DecideLeaveRequestDto(), {
    decision: LeaveRequestStatus.APPROVED,
    decidedBy: 'manager-1',
    actorPermissions: [BACKDATED_LEAVE_APPROVE_PERMISSION],
  });

  function makeQueryBuilder(): { setLock: jest.Mock; where: jest.Mock; andWhere: jest.Mock; getOne: jest.Mock } {
    const qb = { setLock: jest.fn(), where: jest.fn(), andWhere: jest.fn(), getOne: jest.fn() };
    qb.setLock.mockReturnValue(qb);
    qb.where.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    return qb;
  }

  beforeEach(() => {
    requestQueryBuilder = makeQueryBuilder();
    balanceQueryBuilder = makeQueryBuilder();

    manager = {
      createQueryBuilder: jest
        .fn()
        .mockImplementationOnce(() => requestQueryBuilder)
        .mockImplementationOnce(() => balanceQueryBuilder),
      increment: jest.fn().mockResolvedValue({}),
      decrement: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findOneByOrFail: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    approvalQueue = { cancelReminder: jest.fn().mockResolvedValue(undefined) };
    natsClient = { publish: jest.fn().mockResolvedValue(undefined) };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    service = new DecideLeaveRequestService(
      dataSource as DataSource,
      approvalQueue as unknown as LeaveApprovalQueueService,
      natsClient as unknown as AttendanceLeaveNatsClientService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  });

  it('approves: releases pending_days, increments used_days, updates status, cancels the reminder, and publishes the approval event', async () => {
    requestQueryBuilder.getOne.mockResolvedValue(pendingRequest());
    balanceQueryBuilder.getOne.mockResolvedValue(balance());
    manager.findOneByOrFail.mockResolvedValue(
      pendingRequest({ status: LeaveRequestStatus.APPROVED, decidedAt: new Date(), decidedBy: 'manager-1' }),
    );

    await service.decide(tenantId, 'request-1', approveDto);

    expect(manager.decrement).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ employeeId: 'emp-1' }),
      'pendingDays',
      3,
    );
    expect(manager.increment).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ employeeId: 'emp-1' }),
      'usedDays',
      3,
    );
    expect(manager.update).toHaveBeenCalledWith(
      LeaveRequest,
      { id: 'request-1' },
      expect.objectContaining({ status: 'approved', decidedBy: 'manager-1' }),
    );
    expect(approvalQueue.cancelReminder).toHaveBeenCalledWith('request-1');
    expect(natsClient.publish).toHaveBeenCalledWith(
      ATTENDANCE_LEAVE_SUBJECTS.LEAVE_REQUEST_APPROVED,
      expect.objectContaining({ leaveRequestId: 'request-1', employeeId: 'emp-1' }),
      'request-1',
    );
  });

  it('rejects: releases pending_days WITHOUT incrementing used_days, and does NOT publish an approval event', async () => {
    requestQueryBuilder.getOne.mockResolvedValue(pendingRequest());
    balanceQueryBuilder.getOne.mockResolvedValue(balance());
    manager.findOneByOrFail.mockResolvedValue(pendingRequest({ status: LeaveRequestStatus.REJECTED }));

    await service.decide(tenantId, 'request-1', rejectDto);

    expect(manager.decrement).toHaveBeenCalledWith(
      LeaveBalance,
      expect.objectContaining({ employeeId: 'emp-1' }),
      'pendingDays',
      3,
    );
    expect(manager.increment).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      LeaveRequest,
      { id: 'request-1' },
      expect.objectContaining({
        status: 'rejected',
        decidedBy: 'manager-1',
        decisionReason: 'Coverage gap on the requested dates.',
      }),
    );
    expect(natsClient.publish).not.toHaveBeenCalled();
  });

  it('does not throw if the approval-event publish fails - best-effort (ADR-0078)', async () => {
    requestQueryBuilder.getOne.mockResolvedValue(pendingRequest());
    balanceQueryBuilder.getOne.mockResolvedValue(balance());
    manager.findOneByOrFail.mockResolvedValue(
      pendingRequest({ status: LeaveRequestStatus.APPROVED, decidedAt: new Date(), decidedBy: 'manager-1' }),
    );
    natsClient.publish.mockRejectedValue(new Error('nats down'));

    await expect(service.decide(tenantId, 'request-1', approveDto)).resolves.toEqual(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('rejects with LeaveRequestNotFoundError when the request does not exist, without touching any balance or publishing', async () => {
    requestQueryBuilder.getOne.mockResolvedValue(null);

    await expect(service.decide(tenantId, 'missing', approveDto)).rejects.toThrow(LeaveRequestNotFoundError);
    expect(manager.decrement).not.toHaveBeenCalled();
    expect(approvalQueue.cancelReminder).not.toHaveBeenCalled();
    expect(natsClient.publish).not.toHaveBeenCalled();
  });

  it('rejects with LeaveRequestAlreadyDecidedError when the request is not pending, without touching any balance or publishing', async () => {
    requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ status: LeaveRequestStatus.APPROVED }));

    await expect(service.decide(tenantId, 'request-1', approveDto)).rejects.toThrow(LeaveRequestAlreadyDecidedError);
    expect(manager.decrement).not.toHaveBeenCalled();
    expect(approvalQueue.cancelReminder).not.toHaveBeenCalled();
    expect(natsClient.publish).not.toHaveBeenCalled();
  });

  describe('backdated requests (§5.1, Phase 6, ADR-0079)', () => {
    it('rejects approval of a backdated request without the elevated permission, without touching the LeaveBalance lock or the request update', async () => {
      requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ isBackdated: true, backdatedReason: 'late' }));

      await expect(service.decide(tenantId, 'request-1', approveDto)).rejects.toThrow(InsufficientPermissionError);
      expect(balanceQueryBuilder.getOne).not.toHaveBeenCalled();
      expect(manager.decrement).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(approvalQueue.cancelReminder).not.toHaveBeenCalled();
      expect(auditClient.recordEvent).not.toHaveBeenCalled();
    });

    it('approves a backdated request when actorPermissions includes backdated_leave_entry:approve: sets backdatedApprovedBy and records an audit event with payrollResyncRequired: true', async () => {
      requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ isBackdated: true, backdatedReason: 'late' }));
      balanceQueryBuilder.getOne.mockResolvedValue(balance());
      manager.findOneByOrFail.mockResolvedValue(
        pendingRequest({
          isBackdated: true,
          backdatedReason: 'late',
          status: LeaveRequestStatus.APPROVED,
          decidedAt: new Date(),
          decidedBy: 'manager-1',
          backdatedApprovedBy: 'manager-1',
        }),
      );

      await service.decide(tenantId, 'request-1', approveWithPermissionDto);

      expect(manager.update).toHaveBeenCalledWith(
        LeaveRequest,
        { id: 'request-1' },
        expect.objectContaining({ status: 'approved', backdatedApprovedBy: 'manager-1' }),
      );
      expect(auditClient.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          actorId: 'manager-1',
          actorType: 'user',
          action: 'approve_backdated_leave_request',
          resourceType: 'leave_request',
          resourceId: 'request-1',
          afterStateJson: expect.stringContaining('"payrollResyncRequired":true'),
        }),
      );
    });

    it('rejecting a backdated request needs no elevated permission, sets backdatedApprovedBy to null, and audits with payrollResyncRequired: false', async () => {
      requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ isBackdated: true, backdatedReason: 'late' }));
      balanceQueryBuilder.getOne.mockResolvedValue(balance());
      manager.findOneByOrFail.mockResolvedValue(
        pendingRequest({ isBackdated: true, backdatedReason: 'late', status: LeaveRequestStatus.REJECTED }),
      );

      await service.decide(tenantId, 'request-1', rejectDto);

      expect(manager.update).toHaveBeenCalledWith(
        LeaveRequest,
        { id: 'request-1' },
        expect.objectContaining({ status: 'rejected', backdatedApprovedBy: null }),
      );
      expect(auditClient.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reject_backdated_leave_request',
          afterStateJson: expect.stringContaining('"payrollResyncRequired":false'),
        }),
      );
    });

    it('does not throw and still returns the decision if the audit call fails - best-effort, same posture as the NATS publish', async () => {
      requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ isBackdated: true, backdatedReason: 'late' }));
      balanceQueryBuilder.getOne.mockResolvedValue(balance());
      manager.findOneByOrFail.mockResolvedValue(
        pendingRequest({
          isBackdated: true,
          backdatedReason: 'late',
          status: LeaveRequestStatus.APPROVED,
          decidedAt: new Date(),
          decidedBy: 'manager-1',
          backdatedApprovedBy: 'manager-1',
        }),
      );
      auditClient.recordEvent.mockRejectedValue(new Error('core unreachable'));

      await expect(service.decide(tenantId, 'request-1', approveWithPermissionDto)).resolves.toEqual(
        expect.objectContaining({ status: 'approved' }),
      );
    });

    it('never calls the audit client for an ordinary (non-backdated) decision', async () => {
      requestQueryBuilder.getOne.mockResolvedValue(pendingRequest({ isBackdated: false }));
      balanceQueryBuilder.getOne.mockResolvedValue(balance());
      manager.findOneByOrFail.mockResolvedValue(
        pendingRequest({
          isBackdated: false,
          status: LeaveRequestStatus.APPROVED,
          decidedAt: new Date(),
          decidedBy: 'manager-1',
        }),
      );

      await service.decide(tenantId, 'request-1', approveDto);

      expect(auditClient.recordEvent).not.toHaveBeenCalled();
    });
  });
});
