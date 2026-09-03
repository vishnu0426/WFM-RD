/**
 * A transient/infra failure calling shift-marketplace-service's
 * `claimOpenShift` mutation - `CLAIM_ATTEMPT_RATE_LIMITED` (confirmed safe
 * to blind-retry: `ClaimAttemptRateLimiterService.assertNotRateLimited`
 * never itself increments the rate-limit window), `MARKETPLACE_UNAVAILABLE`
 * (Redis down), `GUARDRAIL_VALIDATION_UNAVAILABLE` (Module 04 gRPC down -
 * always surfaces via GraphQL `errors[]`, never a success body, since
 * `claim-open-shift.service.ts` re-throws after its best-effort DB write),
 * network unreachability, or an unreadable response body. Docs/adr/0153's
 * rule: an unmodified retry could plausibly succeed with zero employee
 * action, so this is `failed` (retryable), never `conflict`.
 */
export class MarketplaceClaimForwardFailedError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceClaimForwardFailedError';
  }
}
