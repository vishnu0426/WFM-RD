import { Args, ID, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { Inject } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ReallocationApprovalService } from '../../reallocation/reallocation-approval.service';
import { ReallocationQueryService } from '../../reallocation/reallocation-query.service';
import { ReallocationActionResult, toReallocationActionResult } from '../../reallocation/types';
import { GRAPHQL_PUBSUB } from '../pubsub.provider';
import { reallocationSuggestedTrigger } from '../subscription-triggers';

/**
 * §4.1's `approveReallocation`/`reallocationSuggested`, plus the
 * `pendingReallocations` query this phase adds (design doc assumption 8 -
 * without it, `approveReallocation` has no way to discover a suggestion's
 * id in practice, the same necessity Phase 5's `activeAlerts` already
 * established for `acknowledgeAlert`).
 */
@Resolver(() => ReallocationActionResult)
export class ReallocationResolver {
  constructor(
    private readonly reallocationQuery: ReallocationQueryService,
    private readonly reallocationApproval: ReallocationApprovalService,
    private readonly tenantContext: TenantContextService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  @Query(() => [ReallocationActionResult], { name: 'pendingReallocations' })
  async pendingReallocations(
    @Args('orgUnitId', { type: () => ID, nullable: true }) _orgUnitId?: string,
  ): Promise<ReallocationActionResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const actions = await this.reallocationQuery.listPendingReallocations(tenantId);
    return actions.map(toReallocationActionResult);
  }

  @Mutation(() => ReallocationActionResult)
  async approveReallocation(
    @Args('reallocationId', { type: () => ID }) reallocationId: string,
  ): Promise<ReallocationActionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const action = await this.reallocationApproval.approve(tenantId, reallocationId);
    return toReallocationActionResult(action);
  }

  @Subscription(() => ReallocationActionResult, { name: 'reallocationSuggested' })
  reallocationSuggested(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('orgUnitId', { type: () => ID, nullable: true }) _orgUnitId?: string,
  ): AsyncIterator<unknown> {
    return this.pubSub.asyncIterator(reallocationSuggestedTrigger(tenantId));
  }
}
