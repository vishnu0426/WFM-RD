import { AgentLiveStateQueryService } from '../../src/live-state/agent-live-state-query.service';
import { IntradayRedisUnavailableError } from '../../src/redis/redis.service';

describe('AgentLiveStateQueryService.getAgentLiveState', () => {
  const TENANT_ID = 't1';
  const EMPLOYEE_ID = 'e1';

  it('returns dataFreshness "ok" when Redis has a live record', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockResolvedValue({
        currentActivity: 'on_call',
        activityStartedAt: '2026-08-07T10:00:00.000Z',
        scheduledActivity: 'on_shift',
        adherenceStatus: null,
        siteId: null,
        queueId: null,
        lastUpdatedAt: '2026-08-07T10:00:05.000Z',
      }),
    };
    const dataSource = { transaction: jest.fn() };
    const service = new AgentLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getAgentLiveState(TENANT_ID, EMPLOYEE_ID);

    expect(result?.currentActivity).toBe('on_call');
    expect(result?.dataFreshness.status).toBe('ok');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('returns null when Redis has no record and there is no AdherenceEvent fallback path taken', async () => {
    const redis = { readAgentLiveState: jest.fn().mockResolvedValue(null) };
    const dataSource = { transaction: jest.fn() };
    const service = new AgentLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getAgentLiveState(TENANT_ID, EMPLOYEE_ID);

    expect(result).toBeNull();
  });

  it('falls back to the most recent AdherenceEvent when Redis is unavailable (§6.1)', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockRejectedValue(new IntradayRedisUnavailableError('read', new Error('down'))),
    };
    const previousEvent = {
      toActivity: 'break',
      scheduledActivity: 'on_shift',
      timestamp: new Date('2026-08-07T09:55:00.000Z'),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(previousEvent) }),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new AgentLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getAgentLiveState(TENANT_ID, EMPLOYEE_ID);

    expect(result).toMatchObject({
      employeeId: EMPLOYEE_ID,
      currentActivity: 'break',
      scheduledActivity: 'on_shift',
      activityStartedAt: null,
      adherenceStatus: null,
    });
    expect(result?.dataFreshness).toEqual({ status: 'degraded', lastKnownUpdateAt: previousEvent.timestamp });
  });

  it('returns null (not an error) when Redis is unavailable and there is no AdherenceEvent history either', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockRejectedValue(new IntradayRedisUnavailableError('read', new Error('down'))),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue({ findOne: jest.fn().mockResolvedValue(null) }),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new AgentLiveStateQueryService(redis as never, dataSource as never);

    const result = await service.getAgentLiveState(TENANT_ID, EMPLOYEE_ID);

    expect(result).toBeNull();
  });

  it('rethrows an error that is not IntradayRedisUnavailableError, without falling back', async () => {
    const redis = { readAgentLiveState: jest.fn().mockRejectedValue(new Error('unexpected')) };
    const dataSource = { transaction: jest.fn() };
    const service = new AgentLiveStateQueryService(redis as never, dataSource as never);

    await expect(service.getAgentLiveState(TENANT_ID, EMPLOYEE_ID)).rejects.toThrow('unexpected');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
