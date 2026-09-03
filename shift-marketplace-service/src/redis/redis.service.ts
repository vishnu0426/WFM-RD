import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { claimLockKey } from './keys';
import { MetricsService } from '../common/metrics/metrics.service';

export class MarketplaceRedisUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Redis unavailable during ${operation}: ${(cause as Error).message}`);
    this.name = 'MarketplaceRedisUnavailableError';
  }
}

// Lua script for a safe ("only delete the lock if it's still mine") release
// - `DEL` alone would let a slow claimant's late release delete a
// different claimant's lock if the TTL already expired and someone else
// won the retry in between (the classic unsafe-Redlock-release bug). Runs
// as one atomic Redis command, so there's no window between the GET and
// the DEL for a third party to race into.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * ADR-0084/ADR-0085: fail-*visible*, same posture as intraday-service's
 * `IntradayRedisService` (ADR-0062) and for the same reason - this lock is
 * the module's actual concurrency-safety mechanism (§4), not a cache. A
 * caller that can't tell "lost the race" apart from "can't reach Redis at
 * all" would risk falling back to an unlocked DB write under exactly the
 * contention this module exists to prevent (§0.5's chaos scenario).
 *
 * Deliberately **not** intraday's simpler `SET key 1 EX ttl NX` + plain
 * `DEL` idempotency-lock pattern: that lock only ever needs "did *someone*
 * already claim this," never "release *my* claim specifically," so a bare
 * `DEL` is safe there. This lock protects a live claim attempt across a
 * gRPC round-trip (up to ~2.1s worst-case per scheduling-service's own
 * retry budget, ADR-0082) against the lock's own short TTL - a per-attempt
 * random token plus a compare-and-delete release closes the real, if
 * narrow, unsafe-release window a plain `DEL` would leave open.
 */
@Injectable()
export class MarketplaceRedisService {
  private readonly logger = new Logger(MarketplaceRedisService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    private readonly metrics: MetricsService,
  ) {}

  /** Never throws - `HealthController.readiness()` needs a status, not an exception. */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      await this.client.ping();
      this.metrics.redisUp.set(1);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      this.logger.warn(`Redis PING failed: ${(err as Error).message}`);
      this.metrics.redisUp.set(0);
      return { ok: false, latencyMs: Date.now() - startedAt };
    }
  }

  /**
   * `SET key token EX ttlSeconds NX` - the lock winner gets a random
   * `token` back (pass it to `releaseClaimLock`); the lock loser gets
   * `null` immediately, no queuing (§4 step 3's fast-fail UX requirement).
   */
  async acquireClaimLock(tenantId: string, marketplacePostId: string, ttlSeconds: number): Promise<string | null> {
    const key = claimLockKey(tenantId, marketplacePostId);
    const token = randomUUID();
    try {
      const result = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
      this.metrics.redisUp.set(1);
      if (result !== 'OK') {
        this.metrics.lockContentionTotal.inc();
        return null;
      }
      return token;
    } catch (err) {
      this.metrics.redisUp.set(0);
      throw new MarketplaceRedisUnavailableError(`acquireClaimLock(${key})`, err);
    }
  }

  /**
   * Best-effort: logs and swallows rather than throwing, so a release
   * failure (e.g. a transient Redis blip right as the claim finishes) never
   * masks the claim's own real outcome. The TTL is the backstop if this
   * never runs at all - never rely on it as the only release path, but
   * never let its own failure become the caller's failure either.
   */
  async releaseClaimLock(tenantId: string, marketplacePostId: string, token: string): Promise<void> {
    const key = claimLockKey(tenantId, marketplacePostId);
    try {
      await this.client.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      this.logger.warn(`Failed to release claim lock ${key}: ${(err as Error).message}`);
    }
  }
}
