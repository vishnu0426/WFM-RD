import { RedisHeartbeatService } from '../../src/redis/redis-heartbeat.service';

describe('RedisHeartbeatService.tick', () => {
  it('reports up: sets the gauge and observes latency, no transition log', async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: true, latencyMs: 3 }) };
    const metrics = { setRedisUp: jest.fn(), observeRedisOperation: jest.fn() };
    const service = new RedisHeartbeatService(redis as never, metrics as never);

    await service.tick();

    expect(metrics.setRedisUp).toHaveBeenCalledWith(true);
    expect(metrics.observeRedisOperation).toHaveBeenCalledWith('heartbeat', 0.003);
  });

  it('logs a down transition only on the first failure after being up', async () => {
    const redis = { ping: jest.fn().mockResolvedValue({ ok: false, latencyMs: 1000 }) };
    const metrics = { setRedisUp: jest.fn(), observeRedisOperation: jest.fn() };
    const service = new RedisHeartbeatService(redis as never, metrics as never);
    const errorSpy = jest.spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error');

    await service.tick();
    await service.tick();

    expect(metrics.setRedisUp).toHaveBeenCalledWith(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs a recovery transition when flipping from down back to up', async () => {
    const redis = { ping: jest.fn() };
    const metrics = { setRedisUp: jest.fn(), observeRedisOperation: jest.fn() };
    const service = new RedisHeartbeatService(redis as never, metrics as never);
    const logSpy = jest.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log');

    redis.ping.mockResolvedValueOnce({ ok: false, latencyMs: 1000 });
    await service.tick();
    redis.ping.mockResolvedValueOnce({ ok: true, latencyMs: 2 });
    await service.tick();

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
