import { DomainError } from './domain-error';

/** The open attendance record this clock-out targeted was closed by a concurrent event between the read and the write. */
export class AttendanceRecordConflictError extends DomainError {
  constructor(attendanceRecordId: string) {
    super(
      'ATTENDANCE_RECORD_CONFLICT',
      `Attendance record ${attendanceRecordId} was already closed by a concurrent event.`,
    );
  }
}
