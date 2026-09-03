import type Redis from 'ioredis';
import { MarketplaceRedisService, MarketplaceRedisUnavailableError } from '../../../src/redis/redis.service';
import { claimLockKey } from '../../../src/redis/keys';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MarketplaceRedisService (ADR-0085)', () => {
  let client: { set: jest.Mock; eval: jest.Mock; ping: jest.Mock };
  let metrics: MetricsService;
  let service: MarketplaceRedisService;

  beforeEach(() => {
    client = { set: jest.fn(), eval: jest.fn(), ping: jest.fn() };
    metrics = new MetricsService();
    service = new MarketplaceRedisService(client as unknown as Redis, metrics);
  });

  it('acquireClaimLock issues SET key token EX ttl NX and returns the token on success', async () => {
    client.set.mockResolvedValue('OK');

    const token = await service.acquireClaimLock('tenant-1', 'post-1', 5);

    expect(token).not.toBeNull();
    expect(client.set).toHaveBeenCalledWith(claimLockKey('tenant-1', 'post-1'), token, 'EX', 5, 'NX');
  });

  it('acquireClaimLock returns null (the lock loser) when NX fails, without throwing', async () => {
    client.set.mockResolvedValue(null);

    const token = await service.acquireClaimLock('tenant-1', 'post-1', 5);

    expect(token).toBeNull();
  });

  it('§0.5 chaos: acquireClaimLock fails visibly (throws) rather than swallowing a Redis error', async () => {
    client.set.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.acquireClaimLock('tenant-1', 'post-1', 5)).rejects.toBeInstanceOf(
      MarketplaceRedisUnavailableError,
    );
  });

  it('releaseClaimLock runs the compare-and-delete script with the exact key and token', async () => {
    client.eval.mockResolvedValue(1);

    await service.releaseClaimLock('tenant-1', 'post-1', 'my-token');

    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, claimLockKey('tenant-1', 'post-1'), 'my-token');
  });

  it('releaseClaimLock never throws even if Redis is unreachable - best-effort, backstopped by the TTL', async () => {
    client.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.releaseClaimLock('tenant-1', 'post-1', 'my-token')).resolves.toBeUndefined();
  });

  it('ping never throws and reports ok:false on failure', async () => {
    client.ping.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.ping();

    expect(result.ok).toBe(false);
  });

  it('ping sets marketplace_redis_up to 1 on success and 0 on failure', async () => {
    client.ping.mockResolvedValue('PONG');
    await service.ping();
    expect((await metrics.redisUp.get()).values[0].value).toBe(1);

    client.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    await service.ping();
    expect((await metrics.redisUp.get()).values[0].value).toBe(0);
  });

  it('acquireClaimLock sets marketplace_redis_up to 0 when Redis is unreachable', async () => {
    client.set.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.acquireClaimLock('tenant-1', 'post-1', 5)).rejects.toBeInstanceOf(
      MarketplaceRedisUnavailableError,
    );
    expect((await metrics.redisUp.get()).values[0].value).toBe(0);
  });

  it('acquireClaimLock increments marketplace_lock_contention_total on a lost race, not on a win (Shift Marketplace Manager View phase)', async () => {
    client.set.mockResolvedValue('OK');
    await service.acquireClaimLock('tenant-1', 'post-1', 5);
    expect((await metrics.lockContentionTotal.get()).values[0]?.value ?? 0).toBe(0);

    client.set.mockResolvedValue(null);
    await service.acquireClaimLock('tenant-1', 'post-1', 5);
    expect((await metrics.lockContentionTotal.get()).values[0].value).toBe(1);
  });
});
