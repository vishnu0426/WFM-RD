/**
 * shift-marketplace-service reported a real, non-retryable claim
 * rejection - `POST_ALREADY_BEING_CLAIMED` (lost the Redis lock race - the
 * source spec's own worked "someone else claimed it while offline"
 * example), `POST_NOT_OPEN` (the post moved to ANY terminal state while
 * offline - claimed, expired, OR cancelled, not just a claim race -
 * docs/adr/0153), `MARKETPLACE_POST_NOT_FOUND`, or a "successful" (HTTP
 * 200, no GraphQL `errors[]`) response whose `claim.status === 'rejected'`
 * (stale post / real eligibility violation - a second, independent
 * conflict signal only visible by inspecting the success payload).
 * Docs/adr/0153's rule: this exact payload will never succeed unmodified.
 */
export class MarketplaceClaimConflictError extends Error {
  constructor(
    public readonly upstreamCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceClaimConflictError';
  }
}
