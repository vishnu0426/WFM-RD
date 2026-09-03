import { DomainError } from '../../common/errors/domain-error';

/**
 * §5.2: "reject with a clear, distinct error (not a generic 429) once a
 * tenant-configurable threshold is exceeded" - `retryAfterSeconds` is
 * carried in the message/extensions precisely so this reads as "you're
 * rate-limited, try again in N seconds," not an opaque 429 a legitimate
 * user has no way to reason about.
 */
export class ClaimAttemptRateLimitExceededError extends DomainError {
  constructor(retryAfterSeconds: number) {
    super(
      'CLAIM_ATTEMPT_RATE_LIMITED',
      `You have made too many claim attempts recently - try again in ${retryAfterSeconds}s.`,
    );
  }
}
