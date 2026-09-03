import { withBackoffRetry } from '../../../src/sync/batch/providers/rate-limit-backoff';
import { RateLimitExhaustedError } from '../../../src/sync/errors/rate-limit-exhausted.error';

describe('withBackoffRetry', () => {
  it('returns the result immediately on a successful first attempt, no sleep', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const result = await withBackoffRetry(
      'TestProvider',
      { max_retries: 3, base_ms: 1000 },
      async () => ({ result: 'ok' }),
      sleepFn,
    );
    expect(result).toBe('ok');
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries after a rate-limited attempt and succeeds on the next one', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    const result = await withBackoffRetry(
      'TestProvider',
      { max_retries: 3, base_ms: 1000 },
      async () => {
        calls++;
        return calls === 1 ? { rateLimited: true as const } : { result: 'recovered' };
      },
      sleepFn,
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff (base_ms * 2^attempt) when respect_retry_after is not set', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    await withBackoffRetry(
      'TestProvider',
      { max_retries: 3, base_ms: 100 },
      async () => {
        calls++;
        return calls <= 2 ? { rateLimited: true as const } : { result: 'ok' };
      },
      sleepFn,
    );
    expect(sleepFn).toHaveBeenNthCalledWith(1, 100); // 100 * 2^0
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200); // 100 * 2^1
  });

  it('respects a real Retry-After value when respect_retry_after is true', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    await withBackoffRetry(
      'TestProvider',
      { max_retries: 3, base_ms: 100, respect_retry_after: true },
      async () => {
        calls++;
        return calls === 1 ? { rateLimited: true as const, retryAfterMs: 5000 } : { result: 'ok' };
      },
      sleepFn,
    );
    expect(sleepFn).toHaveBeenCalledWith(5000);
  });

  it('falls back to exponential backoff when respect_retry_after is true but no retryAfterMs was given', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    await withBackoffRetry(
      'TestProvider',
      { max_retries: 3, base_ms: 100, respect_retry_after: true },
      async () => {
        calls++;
        return calls === 1 ? { rateLimited: true as const } : { result: 'ok' };
      },
      sleepFn,
    );
    expect(sleepFn).toHaveBeenCalledWith(100);
  });

  it('throws RateLimitExhaustedError after exhausting max_retries, without ever silently succeeding', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    await expect(
      withBackoffRetry(
        'TestProvider',
        { max_retries: 2, base_ms: 10 },
        async () => {
          calls++;
          return { rateLimited: true as const };
        },
        sleepFn,
      ),
    ).rejects.toThrow(RateLimitExhaustedError);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it('calls onRateLimited with the computed delay on each retry, but not on the final exhausted attempt', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const onRateLimited = jest.fn().mockResolvedValue(undefined);
    await expect(
      withBackoffRetry(
        'TestProvider',
        { max_retries: 2, base_ms: 10 },
        async () => ({ rateLimited: true as const }),
        sleepFn,
        onRateLimited,
      ),
    ).rejects.toThrow(RateLimitExhaustedError);
    // 2 retries happen (attempts 0 and 1), the 3rd (final, exhausted)
    // attempt throws instead of sleeping/retrying - onRateLimited only
    // fires for the two real waits, matching sleepFn's own call count.
    expect(onRateLimited).toHaveBeenCalledTimes(2);
    expect(onRateLimited).toHaveBeenNthCalledWith(1, 10);
    expect(onRateLimited).toHaveBeenNthCalledWith(2, 20);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('uses default max_retries/base_ms when the provider config carries neither', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    const result = await withBackoffRetry(
      'TestProvider',
      {},
      async () => {
        calls++;
        return calls === 1 ? { rateLimited: true as const } : { result: 'ok' };
      },
      sleepFn,
    );
    expect(result).toBe('ok');
    expect(sleepFn).toHaveBeenCalledWith(1000); // default base_ms
  });
});
