import { AlertResolver } from '../../src/graphql/resolvers/alert.resolver';
import { alertRaisedTrigger } from '../../src/graphql/subscription-triggers';

describe('AlertResolver', () => {
  it('activeAlerts resolves the tenant from context and delegates to AlertQueryService', async () => {
    const expected = [{ id: 'a1', tenantId: 't1', status: 'open' }];
    const alertQuery = { listActiveAlerts: jest.fn().mockResolvedValue(expected) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new AlertResolver(alertQuery as never, {} as never, tenantContext as never, {} as never);

    const result = await resolver.activeAlerts();

    expect(alertQuery.listActiveAlerts).toHaveBeenCalledWith('t1');
    expect(result[0]).toMatchObject({ id: 'a1', status: 'open' });
  });

  it('acknowledgeAlert requires both tenant and actor context and delegates to AlertAcknowledgeService', async () => {
    const acknowledged = { id: 'a1', tenantId: 't1', status: 'acknowledged', acknowledgedBy: 'actor-1' };
    const alertAcknowledge = { acknowledge: jest.fn().mockResolvedValue(acknowledged) };
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
      requireActorId: jest.fn().mockReturnValue('actor-1'),
    };
    const resolver = new AlertResolver({} as never, alertAcknowledge as never, tenantContext as never, {} as never);

    const result = await resolver.acknowledgeAlert('a1');

    expect(alertAcknowledge.acknowledge).toHaveBeenCalledWith('t1', 'a1', 'actor-1');
    expect(result).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'actor-1' });
  });

  it('acknowledgeAlert propagates ActorContextMissingError when no actor is bound', async () => {
    const alertAcknowledge = { acknowledge: jest.fn() };
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
      requireActorId: jest.fn().mockImplementation(() => {
        throw new Error('ACTOR_CONTEXT_MISSING');
      }),
    };
    const resolver = new AlertResolver({} as never, alertAcknowledge as never, tenantContext as never, {} as never);

    await expect(resolver.acknowledgeAlert('a1')).rejects.toThrow('ACTOR_CONTEXT_MISSING');
    expect(alertAcknowledge.acknowledge).not.toHaveBeenCalled();
  });

  it('alertRaised subscribes to the exact per-tenant PubSub trigger the pipeline publishes to', () => {
    const asyncIterator = Symbol('iterator');
    const pubSub = { asyncIterator: jest.fn().mockReturnValue(asyncIterator) };
    const resolver = new AlertResolver({} as never, {} as never, {} as never, pubSub as never);

    const result = resolver.alertRaised('t1');

    expect(pubSub.asyncIterator).toHaveBeenCalledWith(alertRaisedTrigger('t1'));
    expect(result).toBe(asyncIterator);
  });
});
