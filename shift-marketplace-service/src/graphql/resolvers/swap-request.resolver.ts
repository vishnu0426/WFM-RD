import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { SwapRequestService } from '../../marketplace/swap-request.service';
import { SwapRequest } from '../../marketplace/entities/swap-request.entity';
import { SwapRequestResult } from '../../marketplace/types';

@Resolver(() => SwapRequestResult)
export class SwapRequestResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly swapRequestService: SwapRequestService,
  ) {}

  @Query(() => SwapRequestResult, { name: 'swapRequest', nullable: true })
  async swapRequest(@Args('id', { type: () => ID }) id: string): Promise<SwapRequestResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const swap = await this.swapRequestService.findById(tenantId, id);
    return swap ? toSwapRequestResult(swap) : null;
  }

  /**
   * `initiatorEmployeeId` is never a client-supplied argument - same
   * context-bound-actor posture `claimOpenShift` uses (ADR-0084): a
   * proposal is always "I am offering my own shift," never one submitted
   * on someone else's behalf. `targetEmployeeId`/`targetShiftId`/
   * `targetOrgUnitId` are all-or-nothing (a closed swap names its target
   * up front; an open swap leaves all three null) - enforced at the
   * database level too (`swap_request_target_pair_check`).
   */
  @Mutation(() => SwapRequestResult)
  async proposeSwap(
    @Args('initiatorShiftId', { type: () => ID }) initiatorShiftId: string,
    @Args('initiatorOrgUnitId', { type: () => ID }) initiatorOrgUnitId: string,
    @Args('targetEmployeeId', { type: () => ID, nullable: true }) targetEmployeeId?: string,
    @Args('targetShiftId', { type: () => ID, nullable: true }) targetShiftId?: string,
    @Args('targetOrgUnitId', { type: () => ID, nullable: true }) targetOrgUnitId?: string,
  ): Promise<SwapRequestResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const initiatorEmployeeId = this.tenantContext.requireActorId();
    const swap = await this.swapRequestService.proposeSwap({
      tenantId,
      initiatorEmployeeId,
      initiatorShiftId,
      initiatorOrgUnitId,
      targetEmployeeId,
      targetShiftId,
      targetOrgUnitId,
    });
    return toSwapRequestResult(swap);
  }

  @Mutation(() => SwapRequestResult)
  async respondToSwap(
    @Args('swapRequestId', { type: () => ID }) swapRequestId: string,
    @Args('accept', { type: () => Boolean }) accept: boolean,
    @Args('offeredShiftId', { type: () => ID, nullable: true }) offeredShiftId?: string,
    @Args('offeredOrgUnitId', { type: () => ID, nullable: true }) offeredOrgUnitId?: string,
  ): Promise<SwapRequestResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const respondingEmployeeId = this.tenantContext.requireActorId();
    const swap = await this.swapRequestService.respondToSwap({
      tenantId,
      swapRequestId,
      respondingEmployeeId,
      accept,
      offeredShiftId,
      offeredOrgUnitId,
    });
    return toSwapRequestResult(swap);
  }
}

export function toSwapRequestResult(swap: SwapRequest): SwapRequestResult {
  return {
    id: swap.id,
    initiatorEmployeeId: swap.initiatorEmployeeId,
    initiatorShiftId: swap.initiatorShiftId,
    targetEmployeeId: swap.targetEmployeeId,
    targetShiftId: swap.targetShiftId,
    status: swap.status,
    requiresSupervisorApproval: swap.requiresSupervisorApproval,
    validationResult: swap.validationResult,
    createdAt: swap.createdAt,
    decisionReason: swap.decisionReason,
  };
}
