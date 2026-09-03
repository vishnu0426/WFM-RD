import { QueueLiveStateQueryService } from '../../src/live-state/queue-live-state-query.service';
import { IntradayRedisUnavailableError } from '../../src/redis/redis.service';

describe('QueueLiveStateQueryService.getQueueLiveState', () => {
  const TENANT_ID = 't1';
  const QUEUE_ID = 'q1';

  it('returns dataFreshness "ok" when Redis has a live record', async () => {
    const redis = {
      readQueueLiveState: jest.fn().mockResolvedValue({
        currentVolume: 10,
        agentsAvailable: 3,
        agentsOnCall: 2,
        forecastedVolume: 12,
        serviceLevelCurrent: 0.8,
        serviceLevelTarget: 0.8,
        lastUpdatedAt: '2026-08-07T10:00:00.000Z',
      }),
    };
    const dataSource = { transaction: jest.fn() };
    const service = new QueueLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getQueueLiveState(TENANT_ID, QUEUE_ID);

    expect(result?.currentVolume).toBe(10);
    expect(result?.dataFreshness.status).toBe('ok');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('returns null when nothing has ever written this queue', async () => {
    const redis = { readQueueLiveState: jest.fn().mockResolvedValue(null) };
    const dataSource = { transaction: jest.fn() };
    const service = new QueueLiveStateQueryService(redis as never, dataSource as never);

    expect(await service.getQueueLiveState(TENANT_ID, QUEUE_ID)).toBeNull();
  });

  it('falls back to the most recent QueueMetricsSnapshot when Redis is unavailable (§6.1 Phase 7)', async () => {
    const redis = {
      readQueueLiveState: jest.fn().mockRejectedValue(new IntradayRedisUnavailableError('read', new Error('down'))),
    };
    const snapshot = {
      currentVolume: 42,
      agentsAvailable: 5,
      agentsOnCall: 3,
      forecastedVolume: 40,
      serviceLevelCurrent: 0.81,
      serviceLevelTarget: 0.8,
      capturedAt: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(snapshot) }),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new QueueLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getQueueLiveState(TENANT_ID, QUEUE_ID);

    expect(result).toEqual({
      queueId: QUEUE_ID,
      currentVolume: 42,
      agentsAvailable: 5,
      agentsOnCall: 3,
      forecastedVolume: 40,
      serviceLevelCurrent: 0.81,
      serviceLevelTarget: 0.8,
      dataFreshness: { status: 'degraded', lastKnownUpdateAt: snapshot.capturedAt },
    });
  });

  it('degrades to all-null fields when Redis is unavailable and no snapshot exists either', async () => {
    const redis = {
      readQueueLiveState: jest.fn().mockRejectedValue(new IntradayRedisUnavailableError('read', new Error('down'))),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(null) }),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new QueueLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getQueueLiveState(TENANT_ID, QUEUE_ID);

    expect(result).toEqual({
      queueId: QUEUE_ID,
      currentVolume: null,
      agentsAvailable: null,
      agentsOnCall: null,
      forecastedVolume: null,
      serviceLevelCurrent: null,
      serviceLevelTarget: null,
      dataFreshness: { status: 'degraded', lastKnownUpdateAt: null },
    });
  });

  it('rethrows an error that is not IntradayRedisUnavailableError, without falling back', async () => {
    const redis = { readQueueLiveState: jest.fn().mockRejectedValue(new Error('unexpected')) };
    const dataSource = { transaction: jest.fn() };
    const service = new QueueLiveStateQueryService(redis as never, dataSource as never);

    await expect(service.getQueueLiveState(TENANT_ID, QUEUE_ID)).rejects.toThrow('unexpected');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
