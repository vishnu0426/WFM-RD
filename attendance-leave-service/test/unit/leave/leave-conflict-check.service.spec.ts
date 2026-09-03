import { LeaveConflictCheckService } from '../../../src/leave/leave-conflict-check.service';
import { EmployeeShiftAssignment, ScheduleServiceClient } from '../../../src/common/scheduling/schedule-service-client';
import { UpstreamUnavailableError } from '../../../src/common/errors/upstream-unavailable.error';

function shift(overrides: Partial<EmployeeShiftAssignment> = {}): EmployeeShiftAssignment {
  return {
    id: 'shift-1',
    employeeId: 'emp-1',
    scheduleId: 'sched-1',
    shiftStart: '2026-02-10T09:00:00.000Z',
    shiftEnd: '2026-02-10T17:00:00.000Z',
    skillId: null,
    assignmentSource: 'solver',
    isOvertime: false,
    locked: false,
    publishedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('LeaveConflictCheckService', () => {
  let scheduleClient: jest.Mocked<ScheduleServiceClient>;
  let service: LeaveConflictCheckService;

  beforeEach(() => {
    scheduleClient = { getShiftAssignments: jest.fn() } as unknown as jest.Mocked<ScheduleServiceClient>;
    service = new LeaveConflictCheckService(scheduleClient);
  });

  it('flags a schedule conflict when a shift overlaps the requested date range', async () => {
    scheduleClient.getShiftAssignments.mockResolvedValue([shift()]);
    const result = await service.check('tenant-1', 'emp-1', '2026-02-10', '2026-02-12');
    expect(result.scheduleConflict).toEqual({ hasConflict: true, conflictingShiftIds: ['shift-1'] });
  });

  it('does not flag a conflict when no shift overlaps the requested date range', async () => {
    scheduleClient.getShiftAssignments.mockResolvedValue([
      shift({ shiftStart: '2026-03-01T09:00:00.000Z', shiftEnd: '2026-03-01T17:00:00.000Z' }),
    ]);
    const result = await service.check('tenant-1', 'emp-1', '2026-02-10', '2026-02-12');
    expect(result.scheduleConflict).toEqual({ hasConflict: false, conflictingShiftIds: [] });
  });

  it('always returns orgCoverage: null - no Module 02 capability exists to evaluate it (ADR-0076)', async () => {
    scheduleClient.getShiftAssignments.mockResolvedValue([]);
    const result = await service.check('tenant-1', 'emp-1', '2026-02-10', '2026-02-12');
    expect(result.orgCoverage).toBeNull();
  });

  it('fails closed with UpstreamUnavailableError when scheduling-service is unreachable (§2.2 rule 2)', async () => {
    scheduleClient.getShiftAssignments.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.check('tenant-1', 'emp-1', '2026-02-10', '2026-02-12')).rejects.toThrow(
      UpstreamUnavailableError,
    );
  });
});
