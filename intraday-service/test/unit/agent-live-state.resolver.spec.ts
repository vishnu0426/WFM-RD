import { AgentLiveStateResolver } from '../../src/graphql/resolvers/agent-live-state.resolver';

describe('AgentLiveStateResolver.agentLiveState', () => {
  it('resolves the tenant from context and delegates to AgentLiveStateQueryService', async () => {
    const expected = { employeeId: 'e1' };
    const query = { getAgentLiveState: jest.fn().mockResolvedValue(expected) };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new AgentLiveStateResolver(query as never, tenantContext as never);

    const result = await resolver.agentLiveState('e1');

    expect(result).toBe(expected);
    expect(query.getAgentLiveState).toHaveBeenCalledWith('t1', 'e1');
  });

  it('propagates TenantContextMissingError when no tenant is bound', async () => {
    const query = { getAgentLiveState: jest.fn() };
    const tenantContext = {
      requireTenantId: jest.fn().mockImplementation(() => {
        throw new Error('TENANT_CONTEXT_MISSING');
      }),
    };
    const resolver = new AgentLiveStateResolver(query as never, tenantContext as never);

    await expect(resolver.agentLiveState('e1')).rejects.toThrow('TENANT_CONTEXT_MISSING');
    expect(query.getAgentLiveState).not.toHaveBeenCalled();
  });
});
