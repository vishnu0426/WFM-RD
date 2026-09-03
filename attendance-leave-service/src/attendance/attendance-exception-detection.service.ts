import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttendanceExceptionType } from './entities/attendance-record.entity';
import { EmployeeShiftAssignment, ScheduleServiceClient } from '../common/scheduling/schedule-service-client';
import { getNumberConfig } from '../common/config/get-number-config';

export interface ClockInExceptionResult {
  scheduledShiftId: string | null;
  exceptionType: AttendanceExceptionType | null;
  exceptionMinutes: number | null;
}

export interface ClockOutExceptionResult {
  exceptionType: AttendanceExceptionType | null;
  exceptionMinutes: number | null;
}

/** What `AttendanceIngestionService` already knows about the record a clock-out is closing, without a second Postgres round trip. */
export interface OpenAttendanceRecordContext {
  clockInAt: Date;
  scheduledShiftId: string | null;
  exceptionType: AttendanceExceptionType | null;
}

const MINUTES = 60_000;

/**
 * §2.2 rule 3 / §2.1's `exception_type`/`exception_minutes`: compares a
 * clock event against Module 04's actual `ShiftAssignment` data (via
 * `ScheduleServiceClient`, Phase 1 design doc's explicit assumption 2 -
 * REST, not gRPC) rather than a generic scheduled/unscheduled boolean.
 *
 * `AttendanceRecord` has exactly one `exception_type` column (§2.1's own
 * schema, not this phase's choice to change) - a shift that is both late
 * *and* left early can only carry one flag. This service resolves that by
 * never overwriting an exception already set at clock-in
 * (`detectForClockOut` short-circuits if `exceptionType` is already
 * non-null) - the first anomaly detected wins, not the "worse" one. Flagged
 * explicitly in the design doc as a real, accepted limitation of this
 * phase's schema, not silently swept under a "good enough" comment.
 *
 * `no_show` is deliberately never produced here - detecting the *absence*
 * of a clock-in for a scheduled shift needs a proactive sweep job (a shift
 * ended with nothing to compare against), not an event-driven check. Not
 * built this phase - see the design doc's out-of-scope list.
 */
@Injectable()
export class AttendanceExceptionDetectionService {
  constructor(
    private readonly scheduleClient: ScheduleServiceClient,
    private readonly config: ConfigService,
  ) {}

  async detectForClockIn(tenantId: string, employeeId: string, occurredAt: Date): Promise<ClockInExceptionResult> {
    const graceMinutes = getNumberConfig(this.config, 'ATTENDANCE_LATE_GRACE_MINUTES', 10);
    // A generous +/-12h window covers overnight shifts without over-fetching
    // this employee's entire schedule history for a single clock event.
    const assignments = await this.scheduleClient.getShiftAssignments(
      tenantId,
      employeeId,
      new Date(occurredAt.getTime() - 12 * 60 * MINUTES),
      new Date(occurredAt.getTime() + 12 * 60 * MINUTES),
    );
    const shift = this.findCoveringShift(assignments, occurredAt, graceMinutes);
    if (!shift) {
      return {
        scheduledShiftId: null,
        exceptionType: AttendanceExceptionType.UNSCHEDULED_WORK,
        exceptionMinutes: null,
      };
    }

    const lateMinutes = Math.round((occurredAt.getTime() - new Date(shift.shiftStart).getTime()) / MINUTES);
    if (lateMinutes > graceMinutes) {
      return { scheduledShiftId: shift.id, exceptionType: AttendanceExceptionType.LATE, exceptionMinutes: lateMinutes };
    }
    return { scheduledShiftId: shift.id, exceptionType: null, exceptionMinutes: null };
  }

  async detectForClockOut(
    tenantId: string,
    employeeId: string,
    openRecord: OpenAttendanceRecordContext,
    occurredAt: Date,
  ): Promise<ClockOutExceptionResult> {
    // Already flagged unscheduled_work (no shift to compare against) or
    // already flagged late (single-exception-per-record, see this file's
    // doc comment) - nothing further to detect.
    if (!openRecord.scheduledShiftId || openRecord.exceptionType) {
      return { exceptionType: null, exceptionMinutes: null };
    }

    const graceMinutes = getNumberConfig(this.config, 'ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES', 10);
    const assignments = await this.scheduleClient.getShiftAssignments(
      tenantId,
      employeeId,
      new Date(openRecord.clockInAt.getTime() - 60 * MINUTES),
      new Date(occurredAt.getTime() + 60 * MINUTES),
    );
    const shift = assignments.find((a) => a.id === openRecord.scheduledShiftId);
    // The shift this record was linked to at clock-in is no longer
    // resolvable (e.g. re-optimized away) - don't fabricate a comparison
    // against data we no longer have.
    if (!shift) {
      return { exceptionType: null, exceptionMinutes: null };
    }

    const earlyMinutes = Math.round((new Date(shift.shiftEnd).getTime() - occurredAt.getTime()) / MINUTES);
    if (earlyMinutes > graceMinutes) {
      return { exceptionType: AttendanceExceptionType.EARLY_LEAVE, exceptionMinutes: earlyMinutes };
    }
    return { exceptionType: null, exceptionMinutes: null };
  }

  private findCoveringShift(
    assignments: EmployeeShiftAssignment[],
    occurredAt: Date,
    graceMinutes: number,
  ): EmployeeShiftAssignment | null {
    const occurredAtMs = occurredAt.getTime();
    const graceMs = graceMinutes * MINUTES;
    const candidates = assignments.filter((a) => {
      const start = new Date(a.shiftStart).getTime() - graceMs;
      const end = new Date(a.shiftEnd).getTime() + graceMs;
      return occurredAtMs >= start && occurredAtMs <= end;
    });
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort(
      (a, b) =>
        Math.abs(new Date(a.shiftStart).getTime() - occurredAtMs) -
        Math.abs(new Date(b.shiftStart).getTime() - occurredAtMs),
    );
    return candidates[0];
  }
}
