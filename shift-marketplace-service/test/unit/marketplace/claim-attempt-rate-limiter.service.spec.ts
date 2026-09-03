import { DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ClaimAttemptRateLimiterService } from '../../../src/marketplace/claim-attempt-rate-limiter.service';
import { ClaimAttemptRateLimitExceededError } from '../../../src/marketplace/errors/claim-attempt-rate-limit-exceeded.error';

const TENANT_ID = 'tenant-1';
const EMPLOYEE_ID = 'employee-1';

describe('ClaimAttemptRateLimiterService (§5.2)', () => {
  let query: jest.Mock;
  let dataSource: Partial<DataSource>;

  function makeConfig(values: Record<string, string> = {}): ConfigService {
    return {
      get: jest.fn((key: string, defaultValue?: string) => values[key] ?? defaultValue),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    query = jest.fn();
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work({ query } as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
  });

  // `withTenantConnection` issues its own `SELECT set_config(...)` before
  // the real query on every call, so each scenario primes two resolutions
  // in sequence: the set_config no-op, then the actual row(s).
  function primeSelect(rows: unknown[]): void {
    query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(rows);
  }

  it('allows a first-ever attempt (no engagement-score row yet)', async () => {
    primeSelect([]);
    const service = new ClaimAttemptRateLimiterService(dataSource as DataSource, makeConfig());

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).resolves.toBeUndefined();
    // §2.1's RLS: every query must be tenant-scoped via withTenantConnection.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('allows an attempt when the count is under the limit within the window', async () => {
    primeSelect([{ claim_attempt_count_window: 5, claim_attempt_window_start: new Date() }]);
    const service = new ClaimAttemptRateLimiterService(
      dataSource as DataSource,
      makeConfig({
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT: '10',
        MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS: '60',
      }),
    );

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).resolves.toBeUndefined();
  });

  it('rejects with ClaimAttemptRateLimitExceededError once the count reaches the limit within the window', async () => {
    primeSelect([{ claim_attempt_count_window: 10, claim_attempt_window_start: new Date() }]);
    const service = new ClaimAttemptRateLimiterService(
      dataSource as DataSource,
      makeConfig({
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT: '10',
        MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS: '60',
      }),
    );

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).rejects.toBeInstanceOf(
      ClaimAttemptRateLimitExceededError,
    );
  });

  it('allows the attempt once the window has elapsed, even if the last count was at the limit', async () => {
    primeSelect([{ claim_attempt_count_window: 10, claim_attempt_window_start: new Date(Date.now() - 61_000) }]);
    const service = new ClaimAttemptRateLimiterService(
      dataSource as DataSource,
      makeConfig({
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT: '10',
        MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS: '60',
      }),
    );

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).resolves.toBeUndefined();
  });

  it('respects a tenant-specific override over the default limit', async () => {
    primeSelect([{ claim_attempt_count_window: 3, claim_attempt_window_start: new Date() }]);
    const service = new ClaimAttemptRateLimiterService(
      dataSource as DataSource,
      makeConfig({
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT: '10',
        MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS: '60',
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT_OVERRIDES: JSON.stringify({ [TENANT_ID]: { limit: 3 } }),
      }),
    );

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).rejects.toBeInstanceOf(
      ClaimAttemptRateLimitExceededError,
    );
  });

  it('falls back to defaults when the override config is malformed JSON', async () => {
    primeSelect([]);
    const service = new ClaimAttemptRateLimiterService(
      dataSource as DataSource,
      makeConfig({
        MARKETPLACE_CLAIM_ATTEMPT_LIMIT_OVERRIDES: 'not-json',
      }),
    );

    await expect(service.assertNotRateLimited(TENANT_ID, EMPLOYEE_ID)).resolves.toBeUndefined();
  });

  it('recordFailedAttempt issues a tenant-scoped upsert against marketplace_engagement_score', async () => {
    query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const service = new ClaimAttemptRateLimiterService(dataSource as DataSource, makeConfig());

    await service.recordFailedAttempt(TENANT_ID, EMPLOYEE_ID);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO marketplace.marketplace_engagement_score'),
      [EMPLOYEE_ID, TENANT_ID, '60'],
    );
  });
});
