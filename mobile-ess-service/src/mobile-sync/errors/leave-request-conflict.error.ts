/**
 * attendance-leave-service returned a real, non-retryable domain rejection
 * - `InsufficientLeaveBalanceError` (409), `LeaveBalanceNotFoundError`
 * (404), `BackdatedLeaveNotSupportedError` (400, the request went stale
 * while offline), or `InvalidLeaveRequestError` (400, inverted date range
 * - defense in depth only, the mobile Leave form validates this client-
 * side). Docs/adr/0153's rule: this exact payload will never succeed
 * unmodified, so it's a conflict, not a retryable failure - caught by
 * `mobile-sync.service.ts` and turned into `status: conflict`, surfaced
 * to the employee for explicit resolution, never auto-resolved.
 */
export class LeaveRequestConflictError extends Error {
  constructor(
    public readonly upstreamCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'LeaveRequestConflictError';
  }
}
