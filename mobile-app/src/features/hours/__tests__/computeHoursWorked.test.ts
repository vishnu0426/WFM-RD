import { computeHoursWorked } from '../computeHoursWorked';
import { AttendanceRecordDto } from '@/api/types';

function buildRecord(overrides: Partial<AttendanceRecordDto> = {}): AttendanceRecordDto {
  return {
    id: 'r1',
    employeeId: 'emp-1',
    clockInAt: '2026-08-13T09:00:00.000Z',
    clockOutAt: '2026-08-13T17:00:00.000Z',
    source: 'mobile_app',
    scheduledShiftId: null,
    exceptionType: null,
    exceptionMinutes: null,
    geofenceVerified: null,
    ...overrides,
  };
}

describe('computeHoursWorked', () => {
  it('sums closed-record durations in hours', () => {
    const result = computeHoursWorked([
      buildRecord({ id: 'r1', clockInAt: '2026-08-13T09:00:00.000Z', clockOutAt: '2026-08-13T17:00:00.000Z' }),
      buildRecord({ id: 'r2', clockInAt: '2026-08-12T09:00:00.000Z', clockOutAt: '2026-08-12T13:00:00.000Z' }),
    ]);

    expect(result.totalHours).toBe(12);
    expect(result.closedRecordCount).toBe(2);
    expect(result.openRecord).toBeNull();
  });

  it('excludes a still-open record from the total, returning it separately', () => {
    const openRecord = buildRecord({ id: 'r2', clockInAt: '2026-08-14T09:00:00.000Z', clockOutAt: null });
    const result = computeHoursWorked([
      buildRecord({ id: 'r1', clockInAt: '2026-08-13T09:00:00.000Z', clockOutAt: '2026-08-13T17:00:00.000Z' }),
      openRecord,
    ]);

    expect(result.totalHours).toBe(8);
    expect(result.closedRecordCount).toBe(1);
    expect(result.openRecord).toEqual(openRecord);
  });

  it('returns zero total and no open record for an empty list', () => {
    const result = computeHoursWorked([]);

    expect(result).toEqual({ totalHours: 0, closedRecordCount: 0, openRecord: null });
  });

  it('picks the most recent among multiple open records defensively', () => {
    const older = buildRecord({ id: 'r1', clockInAt: '2026-08-10T09:00:00.000Z', clockOutAt: null });
    const newer = buildRecord({ id: 'r2', clockInAt: '2026-08-14T09:00:00.000Z', clockOutAt: null });

    const result = computeHoursWorked([older, newer]);

    expect(result.openRecord?.id).toBe('r2');
  });
});
