import { Injectable } from '@nestjs/common';
import { ProviderRateLimitConfigService } from '../provider-rate-limit-config.service';

export interface RateLimitDecision {
  allowed: boolean;
  /** Set only when `allowed: false` - an estimate of how long until a token is available. */
  retryAfterMs?: number;
}

interface TokenBucket {
  tokens: number;
  capacity: number;
  refillRatePerMs: number;
  lastRefillAtMs: number;
}

/**
 * §5a: "The sync job runner enforces this *before* making calls, not
 * reactively after a 429 - a token-bucket/sliding-window limiter per
 * (tenant_id, connector_id) pair." A real token bucket, in-memory
 * (process-local) state - a real deployment running more than one instance
 * of this service would need a shared store (Redis) for this to be
 * globally accurate; disclosed explicitly as a real gap, not solved here
 * (see the Phase 5 design doc's explicit assumptions), same posture as
 * every other "single-instance-correct, multi-instance-approximate" piece
 * of state in this build so far.
 *
 * Scoped per `(tenant_id, connector_id)`, per ADR-0135's "per-connector-pair
 * for every batch provider researched, with one structural exception"
 * (ADP) - this service doesn't special-case ADP's own per-node reality
 * (this module has no visibility into which of ADP's gateway nodes a given
 * HTTP call lands on); ADR-0135 already resolved that by seeding ADP's
 * bucket capacity at the tighter per-node figure rather than the more
 * permissive aggregate one, which is sufficient mitigation without needing
 * per-node awareness in code.
 */
@Injectable()
export class RateLimiterService {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly providerConfig: ProviderRateLimitConfigService) {}

  async tryAcquire(tenantId: string, connectorId: string, provider: string): Promise<RateLimitDecision> {
    const config = await this.providerConfig.findByProvider(provider);
    if (!config || config.requestsPerWindow == null || config.windowSeconds == null) {
      // No published/enforced request-rate limit for this provider
      // (§5a/§5c: several providers researched have none) - nothing to
      // throttle against, proceed.
      return { allowed: true };
    }

    const key = `${tenantId}:${connectorId}`;
    const bucket = this.getOrCreateBucket(key, config.requestsPerWindow, config.windowSeconds);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const msUntilNextToken = (1 - bucket.tokens) / bucket.refillRatePerMs;
    return { allowed: false, retryAfterMs: Math.ceil(msUntilNextToken) };
  }

  /** Test/introspection only - never called by production code paths. */
  resetForTests(): void {
    this.buckets.clear();
  }

  private getOrCreateBucket(key: string, capacity: number, windowSeconds: number): TokenBucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const bucket: TokenBucket = {
      tokens: capacity,
      capacity,
      refillRatePerMs: capacity / (windowSeconds * 1000),
      lastRefillAtMs: Date.now(),
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillAtMs;
    if (elapsedMs <= 0) return;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedMs * bucket.refillRatePerMs);
    bucket.lastRefillAtMs = now;
  }
}
