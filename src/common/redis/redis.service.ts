import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Thin wrapper, not a leaky abstraction over ioredis: callers that need
 * atomic multi-key operations (none do yet in Phase 2) can still inject the
 * raw client via `getClient()`. Every method here fails open on a Redis
 * error (logs and returns a cache-miss shape) rather than throwing - per §1,
 * Redis backs performance/fast-path optimizations only; every caller
 * (`UserContextCacheService`, `RefreshTokenService`'s family pointer,
 * `TokenService`'s revocation check) has a correct, if slower, Postgres-only
 * fallback path, and a Redis outage must degrade latency, not availability.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET failed for key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis SET failed for key=${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Atomic `SET key value EX ttl NX` - `true` if this call created the key
   * (the caller won the race), `false` if it already existed. Fails open to
   * `true` on a Redis error (§1: a Redis outage must degrade a caller's
   * dedup/locking guarantee, not block the request entirely) - callers using
   * this for idempotency (`IdempotencyInterceptor`, Phase 6) already treat a
   * missing Redis as "can't dedupe, let it through," never as "must reject."
   */
  async setIfNotExists(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`Redis SET NX failed for key=${key}: ${(err as Error).message}`);
      return true;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`Redis DEL failed for key=${key}: ${(err as Error).message}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) === 1;
    } catch (err) {
      this.logger.warn(`Redis EXISTS failed for key=${key}: ${(err as Error).message}`);
      return false;
    }
  }
}
