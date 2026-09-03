import { RateLimitExhaustedError } from '../../errors/rate-limit-exhausted.error';

export interface BackoffStrategy {
  type?: string;
  base_ms?: number;
  max_retries?: number;
  respect_retry_after?: boolean;
  /**
   * Salesforce's own seeded shape (`type: "header_driven"`, ADR-0135) -
   * unlike every other researched provider, a breach isn't a `429` at all,
   * it's this specific status+error-code pair
   * (`developer.salesforce.com`'s own "API Limits" doc). Read only by
   * `SalesforceAdapter`'s own response interpretation, same "provider-
   * adapter-interpreted config, not a fixed shared schema" posture
   * ADR-0135 already established for `backoff_strategy`.
   */
  on_breach_status?: number;
  on_breach_code?: string;
}

export type BackoffAttemptOutcome<T> = { result: T } | { rateLimited: true; retryAfterMs?: number };

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_MS = 1000;

/**
 * §5a's reactive half: "On genuinely hitting a rate limit despite the
 * proactive throttle, apply the provider's backoff_strategy... never
 * silently truncate and report completed." Interprets exactly the shape
 * `ProviderRateLimitConfig.backoff_strategy` actually carries for a given
 * provider (`docs/module-12-provider-research.md`) - `base_ms`/`max_retries`
 * exponential backoff, optionally overridden per-attempt by a real
 * `Retry-After` value when `respect_retry_after` is set (ADR-0135:
 * `backoff_strategy` is provider-adapter-interpreted config, not a fixed
 * shared schema - this helper reads only the two fields every researched
 * provider's exponential-shaped strategy actually has, and ignores
 * provider-specific extras like `header_driven`'s own fields).
 *
 * `onRateLimited`, when passed, is called with the computed delay right
 * before each real retry wait - `BatchSyncRunnerService.runOne` passes one
 * that writes `SyncJob.rateLimitedUntil` (§5a's live "this running job is
 * currently throttled" signal), threaded down through each adapter's own
 * fetch method. Appended after `sleepFn` rather than before it so every
 * existing positional `sleepFn` call in this module's own tests keeps
 * working unchanged.
 *
 * `sleepFn` is injectable so unit tests can run this with zero real delay
 * instead of waiting through real exponential backoff.
 */
export async function withBackoffRetry<T>(
  provider: string,
  strategy: BackoffStrategy,
  attempt: (attemptNumber: number) => Promise<BackoffAttemptOutcome<T>>,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRateLimited?: (delayMs: number) => Promise<void>,
): Promise<T> {
  const maxRetries = strategy.max_retries ?? DEFAULT_MAX_RETRIES;
  const baseMs = strategy.base_ms ?? DEFAULT_BASE_MS;

  for (let attemptNumber = 0; attemptNumber <= maxRetries; attemptNumber++) {
    const outcome = await attempt(attemptNumber);
    if ('result' in outcome) {
      return outcome.result;
    }
    if (attemptNumber === maxRetries) {
      throw new RateLimitExhaustedError(provider, maxRetries);
    }
    const delayMs =
      strategy.respect_retry_after && outcome.retryAfterMs !== undefined
        ? outcome.retryAfterMs
        : baseMs * 2 ** attemptNumber;
    // §5a's live signal: a real retry is about to happen, distinct from the
    // final exhausted attempt above (which throws instead - no live wait to
    // report there). Never allowed to abort the retry loop itself.
    await onRateLimited?.(delayMs);
    await sleepFn(delayMs);
  }

  // Unreachable (the loop above always returns or throws on its last
  // iteration) - satisfies TypeScript's control-flow analysis.
  throw new RateLimitExhaustedError(provider, maxRetries);
}
