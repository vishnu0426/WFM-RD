import { RateLimiterService } from '../../../src/sync/batch/rate-limiter.service';
import { ProviderRateLimitConfigService } from '../../../src/sync/provider-rate-limit-config.service';
import { ProviderRateLimitConfig } from '../../../src/integrations/entities/provider-rate-limit-config.entity';

function fakeProviderConfigService(config: Partial<ProviderRateLimitConfig> | null): ProviderRateLimitConfigService {
  return {
    findByProvider: jest.fn().mockResolvedValue(config),
  } as unknown as ProviderRateLimitConfigService;
}

describe('RateLimiterService', () => {
  it('allows every request when the provider has no seeded rate limit config at all', async () => {
    const limiter = new RateLimiterService(fakeProviderConfigService(null));
    for (let i = 0; i < 100; i++) {
      const decision = await limiter.tryAcquire('t1', 'c1', 'UnknownProvider');
      expect(decision.allowed).toBe(true);
    }
  });

  it('allows every request when requests_per_window/window_seconds are both null (a real, published-limit-absent provider)', async () => {
    const limiter = new RateLimiterService(
      fakeProviderConfigService({ requestsPerWindow: null, windowSeconds: null, concurrentRequestLimit: 20 }),
    );
    for (let i = 0; i < 50; i++) {
      expect((await limiter.tryAcquire('t1', 'c1', 'Five9')).allowed).toBe(true);
    }
  });

  it('allows up to the bucket capacity, then denies with a retryAfterMs estimate', async () => {
    const limiter = new RateLimiterService(fakeProviderConfigService({ requestsPerWindow: 3, windowSeconds: 60 }));
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(true);
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(true);
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(true);
    const denied = await limiter.tryAcquire('t1', 'c1', 'Workday');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('scopes buckets independently per (tenantId, connectorId) - one connector exhausting its bucket does not affect another', async () => {
    const limiter = new RateLimiterService(fakeProviderConfigService({ requestsPerWindow: 1, windowSeconds: 60 }));
    expect((await limiter.tryAcquire('t1', 'connector-A', 'Workday')).allowed).toBe(true);
    expect((await limiter.tryAcquire('t1', 'connector-A', 'Workday')).allowed).toBe(false);
    // A different connector (even same tenant/provider) has its own independent bucket.
    expect((await limiter.tryAcquire('t1', 'connector-B', 'Workday')).allowed).toBe(true);
  });

  it('scopes buckets independently per tenant, even for the same connector id and provider', async () => {
    const limiter = new RateLimiterService(fakeProviderConfigService({ requestsPerWindow: 1, windowSeconds: 60 }));
    expect((await limiter.tryAcquire('tenant-A', 'c1', 'Workday')).allowed).toBe(true);
    expect((await limiter.tryAcquire('tenant-A', 'c1', 'Workday')).allowed).toBe(false);
    expect((await limiter.tryAcquire('tenant-B', 'c1', 'Workday')).allowed).toBe(true);
  });

  it('refills over time - a request denied immediately after exhaustion succeeds again once the window has genuinely elapsed', async () => {
    // A tiny real window (200ms, capacity 1) so this test proves real
    // token-bucket refill math against the real clock without a slow test.
    const limiter = new RateLimiterService(fakeProviderConfigService({ requestsPerWindow: 1, windowSeconds: 0.2 }));
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(true);
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await limiter.tryAcquire('t1', 'c1', 'Workday')).allowed).toBe(true);
  });
});
