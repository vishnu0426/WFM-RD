/**
 * A non-2xx, non-409 response from attendance-leave-service's clock-events
 * endpoint (401 HMAC misconfiguration, 503 upstream-unavailable, or a
 * malformed-body 400) - caught by `mobile-sync.service.ts` and turned into
 * a `failed` (retryable) result for that one action, never allowed to fail
 * the whole batch (source spec §3.2's own instruction).
 */
export class ClockEventForwardFailedError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ClockEventForwardFailedError';
  }
}
