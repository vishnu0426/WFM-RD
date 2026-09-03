import { QueueLiveStateResolver } from '../../src/graphql/resolvers/queue-live-state.resolver';
import { queueLiveStateUpdatedTrigger } from '../../src/graphql/subscription-triggers';

describe('QueueLiveStateResolver', () => {
  it('queueLiveState resolves the tenant from context and delegates to QueueLiveStateQueryService', async () => {
    const expected = { queueId: 'q1' };
    const query = { getQueueLiveState: jest.fn().mockResolvedValue(expected) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new QueueLiveStateResolver(query as never, tenantContext as never, {} as never);

    const result = await resolver.queueLiveState('q1');

    expect(result).toBe(expected);
    expect(query.getQueueLiveState).toHaveBeenCalledWith('t1', 'q1');
  });

  it('queueLiveStateUpdated subscribes to the exact per-queue PubSub trigger the consumer publishes to', () => {
    const asyncIterator = Symbol('iterator');
    const pubSub = { asyncIterator: jest.fn().mockReturnValue(asyncIterator) };
    const resolver = new QueueLiveStateResolver({} as never, {} as never, pubSub as never);

    const result = resolver.queueLiveStateUpdated('q1');

    expect(pubSub.asyncIterator).toHaveBeenCalledWith(queueLiveStateUpdatedTrigger('q1'));
    expect(result).toBe(asyncIterator);
  });
});
