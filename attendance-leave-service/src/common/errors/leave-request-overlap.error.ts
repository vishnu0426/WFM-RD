import { DomainError } from './domain-error';

/**
 * GAP-09 fix (enterprise readiness audit, 2026-08-18): the same employee
 * already has another `pending`/`approved` leave request whose date range
 * overlaps this one - enforced at the database layer by
 * `leave_request_no_overlapping_active_ranges` (an EXCLUDE constraint, see
 * `1700001100000-LeaveRequestNoOverlappingActiveRanges`), not just an
 * application-level check that a concurrent submission could race past.
 */
export class LeaveRequestOverlapError extends DomainError {
  constructor(employeeId: string, dateRangeStart: string, dateRangeEnd: string) {
    super(
      'LEAVE_REQUEST_OVERLAP',
      `Employee ${employeeId} already has a pending or approved leave request overlapping ${dateRangeStart}..${dateRangeEnd}.`,
    );
  }
}
