/**
 * A transient/infra failure calling attendance-leave-service's leave-
 * requests endpoint - `UpstreamUnavailableError` (503, scheduling-service
 * down during the synchronous conflict check), network unreachability, or
 * an unreadable response body. Docs/adr/0153's rule: an unmodified retry
 * could plausibly succeed with zero employee action, so this is `failed`
 * (retryable), never `conflict`.
 */
export class LeaveRequestForwardFailedError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'LeaveRequestForwardFailedError';
  }
}
