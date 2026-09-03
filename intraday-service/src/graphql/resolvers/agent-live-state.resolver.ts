import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AgentLiveStateQueryService } from '../../live-state/agent-live-state-query.service';
import { AgentLiveStateResult } from '../../live-state/types';

/** §4.1's `agentLiveState(employeeId)` query - tenant from context (`TenantContextService`), not a GraphQL argument. */
@Resolver(() => AgentLiveStateResult)
export class AgentLiveStateResolver {
  constructor(
    private readonly agentLiveStateQuery: AgentLiveStateQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Query(() => AgentLiveStateResult, { name: 'agentLiveState', nullable: true })
  async agentLiveState(
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<AgentLiveStateResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.agentLiveStateQuery.getAgentLiveState(tenantId, employeeId);
  }
}
