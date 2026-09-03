import { DomainError } from './domain-error';

/**
 * §2.1: a `clock_out` event must correlate to an already-open (`clock_out_at
 * IS NULL`) `AttendanceRecord` for that employee. This module deliberately
 * rejects rather than fabricates a same-instant clock-in/clock-out record
 * for an orphaned clock-out - inventing attendance data would work against
 * this module's own compliance framing (§0). See
 * docs/module-06-phase-2-design-doc.md's explicit assumptions.
 */
export class NoOpenAttendanceRecordError extends DomainError {
  constructor(employeeId: string) {
    super('NO_OPEN_ATTENDANCE_RECORD', `No open attendance record found for employee ${employeeId} to clock out.`);
  }
}
