import { QueueMetricsUpdatedConsumerService } from '../../src/consumers/queue-metrics-updated.consumer';
import { queueLiveStateUpdatedTrigger } from '../../src/graphql/subscription-triggers';

describe('QueueMetricsUpdatedConsumerService.handlePayload', () => {
  const payload = {
    tenantId: 't1',
    queueId: 'q1',
    currentVolume: 10,
    agentsAvailable: 3,
    agentsOnCall: 2,
    forecastedVolume: 12,
    serviceLevelCurrent: 0.8,
    serviceLevelTarget: 0.8,
  };

  it('writes QueueLiveState and publishes the fresh read-back onto the per-queue PubSub trigger', async () => {
    const redis = {
      writeQueueLiveState: jest.fn().mockResolvedValue(undefined),
      readQueueLiveState: jest.fn().mockResolvedValue({
        currentVolume: 10,
        agentsAvailable: 3,
        agentsOnCall: 2,
        forecastedVolume: 12,
        serviceLevelCurrent: 0.8,
        serviceLevelTarget: 0.8,
        lastUpdatedAt: '2026-08-07T10:00:00.000Z',
      }),
      trackQueueForReallocationScan: jest.fn().mockResolvedValue(undefined),
    };
    const pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
    const alertEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const reallocationEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const staffingOfferEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const consumer = new QueueMetricsUpdatedConsumerService(
      undefined as never,
      redis as never,
      pubSub as never,
      alertEngine as never,
      reallocationEngine as never,
      staffingOfferEngine as never,
    );

    await consumer.handlePayload(payload);

    expect(redis.writeQueueLiveState).toHaveBeenCalledWith('t1', 'q1', {
      currentVolume: 10,
      agentsAvailable: 3,
      agentsOnCall: 2,
      forecastedVolume: 12,
      serviceLevelCurrent: 0.8,
      serviceLevelTarget: 0.8,
    });
    expect(redis.trackQueueForReallocationScan).toHaveBeenCalledWith('t1', 'q1', expect.any(Number));
    expect(alertEngine.evaluateQueueMetrics).toHaveBeenCalledWith(
      't1',
      'q1',
      expect.objectContaining({ serviceLevelCurrent: 0.8 }),
    );
    expect(reallocationEngine.evaluateQueueMetrics).toHaveBeenCalledWith(
      't1',
      'q1',
      expect.objectContaining({ serviceLevelCurrent: 0.8 }),
    );
    expect(staffingOfferEngine.evaluateQueueMetrics).toHaveBeenCalledWith(
      't1',
      'q1',
      expect.objectContaining({ serviceLevelCurrent: 0.8 }),
    );
    expect(pubSub.publish).toHaveBeenCalledWith(
      queueLiveStateUpdatedTrigger('q1'),
      expect.objectContaining({
        queueLiveStateUpdated: expect.objectContaining({ queueId: 'q1', currentVolume: 10 }),
      }),
    );
  });

  it('does not publish if the read-back finds nothing (Redis evicted/unavailable between write and read)', async () => {
    const redis = {
      writeQueueLiveState: jest.fn().mockResolvedValue(undefined),
      readQueueLiveState: jest.fn().mockResolvedValue(null),
      trackQueueForReallocationScan: jest.fn().mockResolvedValue(undefined),
    };
    const pubSub = { publish: jest.fn() };
    const alertEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const reallocationEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const staffingOfferEngine = { evaluateQueueMetrics: jest.fn().mockResolvedValue(undefined) };
    const consumer = new QueueMetricsUpdatedConsumerService(
      undefined as never,
      redis as never,
      pubSub as never,
      alertEngine as never,
      reallocationEngine as never,
      staffingOfferEngine as never,
    );

    await consumer.handlePayload(payload);

    expect(pubSub.publish).not.toHaveBeenCalled();
    expect(reallocationEngine.evaluateQueueMetrics).not.toHaveBeenCalled();
    expect(staffingOfferEngine.evaluateQueueMetrics).not.toHaveBeenCalled();
  });
});
