import { Injectable } from '@nestjs/common';
import { ScheduleServiceClient } from '../common/scheduling/schedule-service-client';
import { UpstreamUnavailableError } from '../common/errors/upstream-unavailable.error';

export interface ScheduleConflictFlag {
  hasConflict: boolean;
  conflictingShiftIds: string[];
}

export interface ConflictFlags {
  scheduleConflict: ScheduleConflictFlag;
  /**
   * §4.4's Module02 org-coverage direction - always `null` this phase.
   * No org-coverage/minimum-staffing concept exists anywhere in Module 02's
   * data model or gRPC surface today (confirmed by reading every .proto
   * Module 02 exposes). `null` here means "not evaluated," never "no
   * conflict" - see ADR-0076 for the full gap and what closing it requires.
   */
  orgCoverage: null;
}

/**
 * §2.2 rule 2 / §4.4: populates `conflict_flags` synchronously, before the
 * `LeaveRequest` write - never deferred to approval time. Module04's
 * schedule-conflict check is real (REST via `ScheduleServiceClient`,
 * ADR-0064, Phase 1's explicit assumption 2); Module02's org-coverage
 * check is a documented, flagged gap (ADR-0076), not a fabricated
 * always-true/always-false result.
 *
 * Fails closed per §2.2 rule 2: a `scheduling-service` failure throws
 * rather than letting the caller proceed with `conflict_flags`
 * incomplete - `LeaveRequestService` calls this before opening any
 * transaction (ADR-0074's ordering principle, restated for this phase).
 */
@Injectable()
export class LeaveConflictCheckService {
  constructor(private readonly scheduleClient: ScheduleServiceClient) {}

  async check(
    tenantId: string,
    employeeId: string,
    dateRangeStart: string,
    dateRangeEnd: string,
    authHeader?: string,
  ): Promise<ConflictFlags> {
    const windowStart = new Date(`${dateRangeStart}T00:00:00.000Z`);
    const windowEnd = new Date(`${dateRangeEnd}T23:59:59.999Z`);

    let assignments;
    try {
      assignments = await this.scheduleClient.getShiftAssignments(tenantId, employeeId, windowStart, windowEnd, authHeader);
    } catch (err) {
      throw new UpstreamUnavailableError('scheduling-service', err);
    }

    const conflicting = assignments.filter((a) => {
      const shiftStart = new Date(a.shiftStart).getTime();
      const shiftEnd = new Date(a.shiftEnd).getTime();
      return shiftStart < windowEnd.getTime() && shiftEnd > windowStart.getTime();
    });

    return {
      scheduleConflict: { hasConflict: conflicting.length > 0, conflictingShiftIds: conflicting.map((a) => a.id) },
      orgCoverage: null,
    };
  }
}
