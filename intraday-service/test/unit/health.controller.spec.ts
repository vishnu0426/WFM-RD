import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../src/common/health/health.controller';

describe('HealthController', () => {
  const makeDataSource = (ok = true) => ({
    query: jest
      .fn()
      .mockImplementation(() => (ok ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('down')))),
  });
  const makeConfig = (region = 'single-region-dev') => ({
    get: jest.fn().mockReturnValue(region),
  });

  it('liveness always reports ok, with no dependency checks', () => {
    const controller = new HealthController(
      { ping: jest.fn() } as never,
      makeDataSource() as never,
      makeConfig() as never,
    );
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it("readiness reports ok when Redis and Postgres are both reachable, including this instance's region (Phase 8)", async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };
    const controller = new HealthController(
      redis as never,
      makeDataSource(true) as never,
      makeConfig('us-east-1') as never,
    );
    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      redis: 'ok',
      redisLatencyMs: 1,
      postgres: 'ok',
      region: 'us-east-1',
    });
  });

  it('readiness throws 503 when Redis is unreachable (ADR-0062 fail-visible, contrast with root app), still carrying region', async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: false, latencyMs: 5 }) };
    const controller = new HealthController(redis as never, makeDataSource(true) as never, makeConfig() as never);
    await expect(controller.readiness()).rejects.toThrow(ServiceUnavailableException);
  });

  it('readiness reports (but does not fail on) an unreachable Postgres - deliberate asymmetry with Redis (Phase 3)', async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };
    const controller = new HealthController(redis as never, makeDataSource(false) as never, makeConfig() as never);
    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      redis: 'ok',
      redisLatencyMs: 1,
      postgres: 'unreachable',
      region: 'single-region-dev',
    });
  });

  it('defaults region to single-region-dev when INTRADAY_REGION is unset', async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };
    const config = { get: jest.fn((_key: string, fallback: string) => fallback) };
    const controller = new HealthController(redis as never, makeDataSource(true) as never, config as never);
    const result = await controller.readiness();
    expect(result.region).toBe('single-region-dev');
  });
});
