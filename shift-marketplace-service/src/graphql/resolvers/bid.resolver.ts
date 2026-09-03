import { UseGuards } from '@nestjs/common';
import { Args, Float, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { BidService } from '../../marketplace/bid.service';
import { BidOpportunityService } from '../../marketplace/bid-opportunity.service';
import { Bid } from '../../marketplace/entities/bid.entity';
import { BidOpportunity } from '../../marketplace/entities/bid-opportunity.entity';
import { BidOpportunityResult, BidResult } from '../../marketplace/types';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

@Resolver(() => BidResult)
export class BidResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly bidService: BidService,
    private readonly bidOpportunityService: BidOpportunityService,
  ) {}

  @Query(() => BidOpportunityResult, { name: 'bidOpportunity', nullable: true })
  async bidOpportunity(@Args('id', { type: () => ID }) id: string): Promise<BidOpportunityResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const opportunity = await this.bidOpportunityService.findById(tenantId, id);
    return opportunity ? toBidOpportunityResult(opportunity) : null;
  }

  /** §5.1: "Expose this via a query (e.g. `bid(id).rankExplanation`)" - read-only transparency, not an appeal workflow. */
  @Query(() => BidResult, { name: 'bid', nullable: true })
  async bid(@Args('id', { type: () => ID }) id: string): Promise<BidResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const bid = await this.bidService.findById(tenantId, id);
    return bid ? toBidResult(bid) : null;
  }

  /**
   * Shift Marketplace Manager View phase, §4 of the frontend prompt: the
   * transparency page's real list query - every bidder's
   * `rankPosition`/`rankExplanation`, not just the winner. Manager-scoped,
   * gated on `bid_opportunity:read` - unlike `bid(id)`/`bidOpportunity(id)`
   * above (unchanged, still ungated for Module 11's own employee-facing
   * single-bid read).
   */
  @Query(() => [BidResult], { name: 'bids' })
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('bid_opportunity:read')
  async bids(@Args('bidOpportunityId', { type: () => ID }) bidOpportunityId: string): Promise<BidResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const bids = await this.bidService.findAllByOpportunity(tenantId, bidOpportunityId);
    return bids.map(toBidResult);
  }

  /**
   * `employeeId` is never a client-supplied argument - same context-bound-
   * actor posture `claimOpenShift`/`proposeSwap` use (ADR-0084).
   * `preferenceScore` only matters (and is only required) when the
   * opportunity's `rankingMethod` is `preference_score` -
   * `BidService.submitBid` enforces that, not this resolver.
   */
  @Mutation(() => BidResult)
  async submitBid(
    @Args('bidOpportunityId', { type: () => ID }) bidOpportunityId: string,
    @Args('preferenceScore', { type: () => Float, nullable: true }) preferenceScore?: number,
  ): Promise<BidResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const employeeId = this.tenantContext.requireActorId();
    const bid = await this.bidService.submitBid({ tenantId, bidOpportunityId, employeeId, preferenceScore });
    return toBidResult(bid);
  }
}

function toBidOpportunityResult(opportunity: BidOpportunity): BidOpportunityResult {
  return {
    id: opportunity.id,
    marketplacePostId: opportunity.marketplacePostId,
    biddingWindowStart: opportunity.biddingWindowStart,
    biddingWindowEnd: opportunity.biddingWindowEnd,
    rankingMethod: opportunity.rankingMethod,
  };
}

function toBidResult(bid: Bid): BidResult {
  return {
    id: bid.id,
    bidOpportunityId: bid.bidOpportunityId,
    employeeId: bid.employeeId,
    rankScore: bid.rankScore === null ? null : Number(bid.rankScore),
    rankPosition: bid.rankPosition,
    rankExplanation: bid.rankExplanation,
    submittedAt: bid.submittedAt,
  };
}
