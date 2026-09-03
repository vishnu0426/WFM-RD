import { ConfigService } from '@nestjs/config';
import { AttendanceExceptionDetectionService } from '../../../src/attendance/attendance-exception-detection.service';
import { AttendanceExceptionType } from '../../../src/attendance/entities/attendance-record.entity';
import { EmployeeShiftAssignment, ScheduleServiceClient } from '../../../src/common/scheduling/schedule-service-client';

function shift(overrides: Partial<EmployeeShiftAssignment> = {}): EmployeeShiftAssignment {
  return {
    id: 'shift-1',
    employeeId: 'emp-1',
    scheduleId: 'sched-1',
    shiftStart: '2026-01-05T09:00:00.000Z',
    shiftEnd: '2026-01-05T17:00:00.000Z',
    skillId: null,
    assignmentSource: 'solver',
    isOvertime: false,
    locked: false,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AttendanceExceptionDetectionService', () => {
  let scheduleClient: jest.Mocked<ScheduleServiceClient>;
  let config: ConfigService;
  let service: AttendanceExceptionDetectionService;

  beforeEach(() => {
    scheduleClient = { getShiftAssignments: jest.fn() } as unknown as jest.Mocked<ScheduleServiceClient>;
    config = new ConfigService({
      ATTENDANCE_LATE_GRACE_MINUTES: 10,
      ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES: 10,
    });
    service = new AttendanceExceptionDetectionService(scheduleClient, config);
  });

  describe('detectForClockIn', () => {
    it('flags unscheduled_work when no shift covers the clock-in', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([]);
      const result = await service.detectForClockIn('tenant-1', 'emp-1', new Date('2026-01-05T09:00:00.000Z'));
      expect(result).toEqual({
        scheduledShiftId: null,
        exceptionType: AttendanceExceptionType.UNSCHEDULED_WORK,
        exceptionMinutes: null,
      });
    });

    it('flags late when the clock-in is past the grace period', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([shift()]);
      // 25 minutes late, grace is 10.
      const result = await service.detectForClockIn('tenant-1', 'emp-1', new Date('2026-01-05T09:25:00.000Z'));
      expect(result).toEqual({
        scheduledShiftId: 'shift-1',
        exceptionType: AttendanceExceptionType.LATE,
        exceptionMinutes: 25,
      });
    });

    it('does not flag late when within the grace period', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([shift()]);
      // 5 minutes late, grace is 10.
      const result = await service.detectForClockIn('tenant-1', 'emp-1', new Date('2026-01-05T09:05:00.000Z'));
      expect(result).toEqual({ scheduledShiftId: 'shift-1', exceptionType: null, exceptionMinutes: null });
    });

    it('picks the shift with the closest start when multiple cover the window', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([
        shift({ id: 'far', shiftStart: '2026-01-05T05:00:00.000Z', shiftEnd: '2026-01-05T13:00:00.000Z' }),
        shift({ id: 'close', shiftStart: '2026-01-05T09:00:00.000Z', shiftEnd: '2026-01-05T17:00:00.000Z' }),
      ]);
      const result = await service.detectForClockIn('tenant-1', 'emp-1', new Date('2026-01-05T09:02:00.000Z'));
      expect(result.scheduledShiftId).toBe('close');
    });
  });

  describe('detectForClockOut', () => {
    it('flags early_leave when clock-out is before the grace period', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([shift()]);
      const result = await service.detectForClockOut(
        'tenant-1',
        'emp-1',
        { clockInAt: new Date('2026-01-05T09:00:00.000Z'), scheduledShiftId: 'shift-1', exceptionType: null },
        new Date('2026-01-05T16:30:00.000Z'), // 30 min early, grace is 10
      );
      expect(result).toEqual({ exceptionType: AttendanceExceptionType.EARLY_LEAVE, exceptionMinutes: 30 });
    });

    it('does not re-evaluate a record that already has an exception (no clobbering late with early_leave)', async () => {
      const result = await service.detectForClockOut(
        'tenant-1',
        'emp-1',
        {
          clockInAt: new Date('2026-01-05T09:25:00.000Z'),
          scheduledShiftId: 'shift-1',
          exceptionType: AttendanceExceptionType.LATE,
        },
        new Date('2026-01-05T16:30:00.000Z'),
      );
      expect(result).toEqual({ exceptionType: null, exceptionMinutes: null });
      expect(scheduleClient.getShiftAssignments).not.toHaveBeenCalled();
    });

    it('skips detection when the clock-in was unscheduled_work (no shift to compare against)', async () => {
      const result = await service.detectForClockOut(
        'tenant-1',
        'emp-1',
        {
          clockInAt: new Date('2026-01-05T09:00:00.000Z'),
          scheduledShiftId: null,
          exceptionType: AttendanceExceptionType.UNSCHEDULED_WORK,
        },
        new Date('2026-01-05T16:30:00.000Z'),
      );
      expect(result).toEqual({ exceptionType: null, exceptionMinutes: null });
      expect(scheduleClient.getShiftAssignments).not.toHaveBeenCalled();
    });

    it('does not fabricate a comparison when the originally-linked shift is no longer resolvable', async () => {
      scheduleClient.getShiftAssignments.mockResolvedValue([shift({ id: 'a-different-shift' })]);
      const result = await service.detectForClockOut(
        'tenant-1',
        'emp-1',
        { clockInAt: new Date('2026-01-05T09:00:00.000Z'), scheduledShiftId: 'shift-1', exceptionType: null },
        new Date('2026-01-05T16:30:00.000Z'),
      );
      expect(result).toEqual({ exceptionType: null, exceptionMinutes: null });
    });
  });
});
