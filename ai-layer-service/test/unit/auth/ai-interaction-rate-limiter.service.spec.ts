import { ConfigService } from '@nestjs/config';
import { AiInteractionRateLimiterService } from '../../../src/auth/ai-interaction-rate-limiter.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_1 = 'actor-1';

function buildLimiter(env: Record<string, string> = {}): AiInteractionRateLimiterService {
  const config = { get: (key: string, def?: string) => env[key] ?? def } as unknown as ConfigService;
  const metrics = new MetricsService();
  metrics.onModuleInit();
  return new AiInteractionRateLimiterService(config, metrics);
}

describe('AiInteractionRateLimiterService (ADR-0162)', () => {
  it('allows requests up to the configured limit within the window, then rejects', () => {
    const limiter = buildLimiter({ AI_INTERACTION_RATE_LIMIT: '3', AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS: '60' });

    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);

    const fourth = limiter.tryAcquire(TENANT_A, ACTOR_1);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks separate buckets per (tenantId, actorId) pair - one actor exhausting their bucket never affects another', () => {
    const limiter = buildLimiter({ AI_INTERACTION_RATE_LIMIT: '1', AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS: '60' });

    expect(limiter.tryAcquire(TENANT_A, 'actor-1').allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, 'actor-1').allowed).toBe(false);
    expect(limiter.tryAcquire(TENANT_A, 'actor-2').allowed).toBe(true);
  });

  it('respects a per-tenant override over the default limit', () => {
    const limiter = buildLimiter({
      AI_INTERACTION_RATE_LIMIT: '1',
      AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS: '60',
      AI_INTERACTION_RATE_LIMIT_OVERRIDES: JSON.stringify({ [TENANT_A]: { limit: 5 } }),
    });

    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    }
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(false);
  });

  it('falls back to the default limit for a tenant with no override, unaffected by other tenants having one', () => {
    const otherTenant = '22222222-2222-2222-2222-222222222222';
    const limiter = buildLimiter({
      AI_INTERACTION_RATE_LIMIT: '2',
      AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS: '60',
      AI_INTERACTION_RATE_LIMIT_OVERRIDES: JSON.stringify({ [otherTenant]: { limit: 100 } }),
    });

    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(false);
  });

  it('never throws on a malformed override config - falls back to the flat default for every tenant', () => {
    const limiter = buildLimiter({
      AI_INTERACTION_RATE_LIMIT: '1',
      AI_INTERACTION_RATE_LIMIT_WINDOW_SECONDS: '60',
      AI_INTERACTION_RATE_LIMIT_OVERRIDES: 'not valid json{{{',
    });

    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(true);
    expect(limiter.tryAcquire(TENANT_A, ACTOR_1).allowed).toBe(false);
  });
});
