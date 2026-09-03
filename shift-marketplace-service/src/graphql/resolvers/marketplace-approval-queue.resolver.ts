import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PendingMarketplaceActionsQueryService } from '../../marketplace/pending-marketplace-actions-query.service';
import { TenantMarketplacePolicyService } from '../../marketplace/tenant-marketplace-policy.service';
import { PendingMarketplaceActionResult } from '../../marketplace/types';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { toMarketplaceClaimResult, toMarketplacePostResult } from './marketplace-post.resolver';
import { toSwapRequestResult } from './swap-request.resolver';

/**
 * Shift Marketplace Manager View phase, §2 of the frontend prompt: the
 * approval queue's read side - `pendingMarketplaceActions` (no equivalent
 * list query existed before this phase) and `marketplaceAutoApprovalEnabled`
 * (§0.5's progressive-delivery requirement: a tenant with auto-approval on
 * should see a clear explanation, not a confusingly empty queue -
 * `TenantMarketplacePolicyService.isAutoApprovalEnabled` existed but was
 * never exposed to any caller before this phase).
 */
@Resolver()
export class MarketplaceApprovalQueueResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly pendingActionsQuery: PendingMarketplaceActionsQueryService,
    private readonly tenantPolicy: TenantMarketplacePolicyService,
  ) {}

  @Query(() => [PendingMarketplaceActionResult], { name: 'pendingMarketplaceActions' })
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_claim:read')
  async pendingMarketplaceActions(
    @Args('orgUnitId', { type: () => ID }) orgUnitId: string,
  ): Promise<PendingMarketplaceActionResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const { claims, swaps } = await this.pendingActionsQuery.listForOrgUnit(tenantId, orgUnitId);

    const claimRows: PendingMarketplaceActionResult[] = claims.map(({ claim, post }) => ({
      claim: toMarketplaceClaimResult(claim),
      claimPost: toMarketplacePostResult(post),
      swap: null,
    }));
    const swapRows: PendingMarketplaceActionResult[] = swaps.map((swap) => ({
      claim: null,
      claimPost: null,
      swap: toSwapRequestResult(swap),
    }));
    return [...claimRows, ...swapRows];
  }

  @Query(() => Boolean, { name: 'marketplaceAutoApprovalEnabled' })
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_claim:read')
  marketplaceAutoApprovalEnabled(): boolean {
    const tenantId = this.tenantContext.requireTenantId();
    return this.tenantPolicy.isAutoApprovalEnabled(tenantId);
  }
}
