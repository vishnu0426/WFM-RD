import { ReallocationResolver } from '../../src/graphql/resolvers/reallocation.resolver';
import { reallocationSuggestedTrigger } from '../../src/graphql/subscription-triggers';

describe('ReallocationResolver', () => {
  it('pendingReallocations resolves the tenant from context and delegates to ReallocationQueryService', async () => {
    const expected = [{ id: 'r1', tenantId: 't1', status: 'suggested', affectedEmployeeIds: [] }];
    const reallocationQuery = { listPendingReallocations: jest.fn().mockResolvedValue(expected) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new ReallocationResolver(
      reallocationQuery as never,
      {} as never,
      tenantContext as never,
      {} as never,
    );

    const result = await resolver.pendingReallocations();

    expect(reallocationQuery.listPendingReallocations).toHaveBeenCalledWith('t1');
    expect(result[0]).toMatchObject({ id: 'r1', status: 'suggested' });
  });

  it('approveReallocation resolves the tenant from context and delegates to ReallocationApprovalService', async () => {
    const approved = { id: 'r1', tenantId: 't1', status: 'executed', affectedEmployeeIds: ['e1'] };
    const reallocationApproval = { approve: jest.fn().mockResolvedValue(approved) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new ReallocationResolver(
      {} as never,
      reallocationApproval as never,
      tenantContext as never,
      {} as never,
    );

    const result = await resolver.approveReallocation('r1');

    expect(reallocationApproval.approve).toHaveBeenCalledWith('t1', 'r1');
    expect(result).toMatchObject({ status: 'executed' });
  });

  it('reallocationSuggested subscribes to the exact per-tenant PubSub trigger the recommendation service publishes to', () => {
    const asyncIterator = Symbol('iterator');
    const pubSub = { asyncIterator: jest.fn().mockReturnValue(asyncIterator) };
    const resolver = new ReallocationResolver({} as never, {} as never, {} as never, pubSub as never);

    const result = resolver.reallocationSuggested('t1');

    expect(pubSub.asyncIterator).toHaveBeenCalledWith(reallocationSuggestedTrigger('t1'));
    expect(result).toBe(asyncIterator);
  });
});
