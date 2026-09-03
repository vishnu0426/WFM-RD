/** §3.4/ADR-0078: `agno.<domain>.<entity>.<event>.v<version>` grammar, matching every other module's subject naming in this platform. */
export const ATTENDANCE_LEAVE_SUBJECTS = {
  LEAVE_REQUEST_APPROVED: 'agno.leave.request.approved.v1',
} as const;

/**
 * §3.4: published by `DecideLeaveRequestService` after a `decideLeaveRequest`
 * transaction commits with `decision: approved` - the push half of the
 * "push in addition to pull" propagation design (`LeaveService.GetUnavailability`
 * is the pull half). Consumed by Module 04 (or a cached read-model of
 * unavailability) to invalidate/refresh proactively, and by Module 01's
 * `AuditLog`/notification pipeline (§4's architecture) - neither consumer
 * is built in this repo yet; this is the producer side only.
 */
export interface LeaveRequestApprovedPayload {
  tenantId: string;
  leaveRequestId: string;
  employeeId: string;
  leaveTypeId: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  decidedAt: string;
  decidedBy: string;
}
