import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../src/common/health/health.controller';

describe('HealthController', () => {
  const makeDeps = () => {
    const dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { getClient: jest.fn().mockReturnValue({ ping: jest.fn().mockResolvedValue('PONG') }) };
    return { dataSource, redis };
  };

  it('liveness always returns ok without checking any dependency', () => {
    const { dataSource, redis } = makeDeps();
    const controller = new HealthController(dataSource as never, redis as never);

    expect(controller.liveness()).toEqual({ status: 'ok' });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('readiness returns ok when both Postgres and Redis are reachable', async () => {
    const { dataSource, redis } = makeDeps();
    const controller = new HealthController(dataSource as never, redis as never);

    await expect(controller.readiness()).resolves.toEqual({ status: 'ok', postgres: 'ok', redis: 'ok' });
  });

  it('readiness reports redis: unreachable but still succeeds when only Redis is down (fail-open, §1)', async () => {
    const { dataSource, redis } = makeDeps();
    redis.getClient.mockReturnValue({ ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const controller = new HealthController(dataSource as never, redis as never);

    await expect(controller.readiness()).resolves.toEqual({ status: 'ok', postgres: 'ok', redis: 'unreachable' });
  });

  it('readiness throws 503 when Postgres is unreachable', async () => {
    const { dataSource, redis } = makeDeps();
    dataSource.query.mockRejectedValue(new Error('connection refused'));
    const controller = new HealthController(dataSource as never, redis as never);

    await expect(controller.readiness()).rejects.toThrow(ServiceUnavailableException);
  });
});
