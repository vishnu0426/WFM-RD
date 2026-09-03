import { AgentStateChangedConsumerService } from '../../src/consumers/agent-state-changed.consumer';

describe('AgentStateChangedConsumerService.handlePayload', () => {
  const payload = {
    tenantId: 't1',
    employeeId: 'e1',
    sourceEventId: 'evt-1',
    currentActivity: 'on_call',
    activityStartedAt: '2026-08-07T10:00:00.000Z',
    siteId: 's1',
    queueId: 'q2',
    receivedAt: '2026-08-07T10:00:00.100Z',
  };

  it('writes currentActivity/activityStartedAt/siteId/queueId, never scheduledActivity/adherenceStatus', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockResolvedValue(null),
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const consumer = new AgentStateChangedConsumerService(undefined as never, redis as never);

    await consumer.handlePayload(payload);

    expect(redis.writeAgentLiveState).toHaveBeenCalledWith('t1', 'e1', {
      currentActivity: 'on_call',
      activityStartedAt: '2026-08-07T10:00:00.000Z',
      siteId: 's1',
      queueId: 'q2',
    });
    // Explicitly never scheduledActivity/adherenceStatus - ScheduledActivityService owns those.
    const written = redis.writeAgentLiveState.mock.calls[0][2];
    expect(written).not.toHaveProperty('scheduledActivity');
    expect(written).not.toHaveProperty('adherenceStatus');
  });

  it('reads the prior AgentLiveState first and updates queue membership from the previous queueId to the new one', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockResolvedValue({ queueId: 'q1' }),
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const consumer = new AgentStateChangedConsumerService(undefined as never, redis as never);

    await consumer.handlePayload(payload);

    expect(redis.readAgentLiveState).toHaveBeenCalledWith('t1', 'e1');
    expect(redis.updateQueueMembership).toHaveBeenCalledWith('t1', 'e1', 'q1', 'q2');
  });

  it('treats no prior AgentLiveState (or no prior queueId) as previousQueueId null', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockResolvedValue(null),
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const consumer = new AgentStateChangedConsumerService(undefined as never, redis as never);

    await consumer.handlePayload(payload);

    expect(redis.updateQueueMembership).toHaveBeenCalledWith('t1', 'e1', null, 'q2');
  });

  it('a failed prior-state read falls back to previousQueueId null rather than blocking the state write', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockRejectedValue(new Error('redis down')),
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const consumer = new AgentStateChangedConsumerService(undefined as never, redis as never);

    await expect(consumer.handlePayload(payload)).resolves.toBeUndefined();

    expect(redis.writeAgentLiveState).toHaveBeenCalled();
    expect(redis.updateQueueMembership).toHaveBeenCalledWith('t1', 'e1', null, 'q2');
  });

  it('a failed queue-membership update does not throw (the state write already succeeded)', async () => {
    const redis = {
      readAgentLiveState: jest.fn().mockResolvedValue({ queueId: 'q1' }),
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const consumer = new AgentStateChangedConsumerService(undefined as never, redis as never);

    await expect(consumer.handlePayload(payload)).resolves.toBeUndefined();
  });
});
