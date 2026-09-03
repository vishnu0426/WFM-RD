import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ApproveMarketplaceActionService } from '../../marketplace/approve-marketplace-action.service';
import { ApproveMarketplaceActionInputInvalidError } from '../../marketplace/errors/approve-marketplace-action-input-invalid.error';
import { ApproveMarketplaceActionResultType } from '../../marketplace/types';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { toMarketplaceClaimResult } from './marketplace-post.resolver';
import { toSwapRequestResult } from './swap-request.resolver';

/**
 * Shift Marketplace Manager View phase: `approveMarketplaceAction` is now
 * gated (previously had no approver-role check of any kind, per
 * `ApproveMarketplaceActionService`'s own doc comment) - `marketplace_claim:approve`
 * is one shared permission for both claim and swap approval/rejection, not
 * a resource per entity, since this mutation (and its new
 * `rejectMarketplaceAction` twin below) already treat the two as one
 * unified action. §0.5's own "no UI nudge toward approval" extends to the
 * backend gate too - approve and reject require exactly the same
 * permission.
 */
@Resolver(() => ApproveMarketplaceActionResultType)
export class ApproveMarketplaceActionResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly approveMarketplaceActionService: ApproveMarketplaceActionService,
  ) {}

  /** §3.1: exactly one of `claimId`/`swapRequestId` must be provided - see `ApproveMarketplaceActionResultType`'s own doc comment for why this isn't a GraphQL union. */
  @Mutation(() => ApproveMarketplaceActionResultType)
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_claim:approve')
  async approveMarketplaceAction(
    @Args('claimId', { type: () => ID, nullable: true }) claimId?: string,
    @Args('swapRequestId', { type: () => ID, nullable: true }) swapRequestId?: string,
  ): Promise<ApproveMarketplaceActionResultType> {
    const tenantId = this.tenantContext.requireTenantId();
    const approverId = this.tenantContext.requireActorId();

    if (claimId && !swapRequestId) {
      const claim = await this.approveMarketplaceActionService.approveClaim(tenantId, claimId, approverId);
      return { claim: toMarketplaceClaimResult(claim), swap: null };
    }
    if (swapRequestId && !claimId) {
      const swap = await this.approveMarketplaceActionService.approveSwap(tenantId, swapRequestId, approverId);
      return { claim: null, swap: toSwapRequestResult(swap) };
    }
    throw new ApproveMarketplaceActionInputInvalidError();
  }

  /**
   * Shift Marketplace Manager View phase, §2 of the frontend prompt: the
   * approval queue's reject action - equally easy, equally visible as
   * approve (§0.5). `reason` is required at the schema level, not merely
   * conventionally expected.
   */
  @Mutation(() => ApproveMarketplaceActionResultType)
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_claim:approve')
  async rejectMarketplaceAction(
    @Args('reason') reason: string,
    @Args('claimId', { type: () => ID, nullable: true }) claimId?: string,
    @Args('swapRequestId', { type: () => ID, nullable: true }) swapRequestId?: string,
  ): Promise<ApproveMarketplaceActionResultType> {
    const tenantId = this.tenantContext.requireTenantId();

    if (claimId && !swapRequestId) {
      const claim = await this.approveMarketplaceActionService.rejectClaim(tenantId, claimId, reason);
      return { claim: toMarketplaceClaimResult(claim), swap: null };
    }
    if (swapRequestId && !claimId) {
      const swap = await this.approveMarketplaceActionService.rejectSwap(tenantId, swapRequestId, reason);
      return { claim: null, swap: toSwapRequestResult(swap) };
    }
    throw new ApproveMarketplaceActionInputInvalidError();
  }
}
