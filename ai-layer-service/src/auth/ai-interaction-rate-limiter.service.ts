import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';

export interface RateLimitDecision {
  allowed: boolean;
  /** Set only when `allowed: false` - seconds until a token is available again. */
  retryAfterSeconds?: number;
}

interface TenantLimitOverride {
  limit?: number;
  windowSeconds?: number;
}

interface TokenBucket {
  tokens: number;
  capacity: number;
  refillRatePerMs: number;
  lastRefillAtMs: number;
}

/**
 * ADR-0162: this service's own explicit LLM-cost/DoS gap - unlike
 * `askQuestion`'s 4,000-character length cap (the only existing guard
 * against abuse), nothing bounded *how often* a caller could trigger one
 * of the five `AIInteraction`-generating operations
 * (`explainSchedule`/`explainForecast`/`explainReallocation`/
 * `rootCauseAnalysis`/`askQuestion`), each of which incurs a real,
 * billable LLM API call. Unlike every other checklist item in this
 * module's own readiness docs, this specific gap was never disclosed
 * anywhere - found only by reading the code, not documented as an
 * accepted trade-off.
 *
 * In-process token bucket, keyed by `(tenantId, actorId)` - own copy of
 * integration-hub-service's `RateLimiterService` shape (ADR-0140) crossed
 * with shift-marketplace-service's `ClaimAttemptRateLimiterService`'s
 * per-tenant-override-map convention (§5.2). Single-instance-correct,
 * multi-instance-approximate (a real deployment running >1 replica of this
 * service would need a shared store for this to be globally accurate) -
 * the same disclosed, accepted trade-off ADR-0140 already took for the
 * same reason: this module has no Redis of its own, and standing one up
 * purely for this would be disproportionate to what closing this gap
 * needs.
 */
@Injectable()
export class AiInteractionRateLimiterService {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;
  private readonly overridesByTenantId: ReadonlyMap<string, TenantLimitOverride>;

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.defaultLimit = Number(config.get<string>('AI_INTERACTION_RATE_LIMIT', '30'));
    this.defaultWindowSeconds = Number(config.get<string>('AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS', '60'));
    this.overridesByTenantId = this.parseOverrides(config.get<string>('AI_INTERACTION_RATE_LIMIT_OVERRIDES', '{}'));
  }

  private parseOverrides(raw: string): ReadonlyMap<string, TenantLimitOverride> {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return new Map(Object.entries(parsed as Record<string, TenantLimitOverride>));
      }
    } catch {
      // A malformed override config should never take down the whole
      // limiter, just fall back to the defaults - same posture
      // ClaimAttemptRateLimiterService's own identical parse takes.
    }
    return new Map();
  }

  private limitsFor(tenantId: string): { limit: number; windowSeconds: number } {
    const override = this.overridesByTenantId.get(tenantId);
    return {
      limit: override?.limit ?? this.defaultLimit,
      windowSeconds: override?.windowSeconds ?? this.defaultWindowSeconds,
    };
  }

  tryAcquire(tenantId: string, actorId: string): RateLimitDecision {
    const { limit, windowSeconds } = this.limitsFor(tenantId);
    const key = `${tenantId}:${actorId}`;
    const bucket = this.getOrCreateBucket(key, limit, windowSeconds);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.metrics.recordAiInteractionRateLimitCheck('allowed');
      return { allowed: true };
    }
    this.metrics.recordAiInteractionRateLimitCheck('exceeded');
    const secondsUntilNextToken = (1 - bucket.tokens) / bucket.refillRatePerMs / 1000;
    return { allowed: false, retryAfterSeconds: Math.ceil(secondsUntilNextToken) };
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
