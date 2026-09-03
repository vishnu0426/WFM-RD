import { Inject, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ClaimOpenShiftService } from '../../marketplace/claim-open-shift.service';
import { MarketplacePostQueryService } from '../../marketplace/marketplace-post-query.service';
import { GuardrailValidationService } from '../../marketplace/guardrail-validation.service';
import { BidOpportunityService } from '../../marketplace/bid-opportunity.service';
import { MarketplacePost, MarketplacePostStatus } from '../../marketplace/entities/marketplace-post.entity';
import { MarketplaceClaim } from '../../marketplace/entities/marketplace-claim.entity';
import { ClaimOpenShiftResultType, MarketplacePostResult } from '../../marketplace/types';
import { GRAPHQL_PUBSUB } from '../pubsub.provider';
import { marketplacePostUpdatedTrigger } from '../subscription-triggers';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

@Resolver(() => MarketplacePostResult)
export class MarketplacePostResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly postQuery: MarketplacePostQueryService,
    private readonly claimOpenShiftService: ClaimOpenShiftService,
    private readonly guardrailValidation: GuardrailValidationService,
    private readonly bidOpportunityService: BidOpportunityService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  @Query(() => MarketplacePostResult, { name: 'marketplacePost', nullable: true })
  async marketplacePost(@Args('id', { type: () => ID }) id: string): Promise<MarketplacePostResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const post = await this.postQuery.findById(tenantId, id);
    return post ? toMarketplacePostResult(post) : null;
  }

  /**
   * Shift Marketplace Manager View phase, §3 of the frontend prompt: the
   * open-posts overview's list query - manager-scoped, gated on
   * `marketplace_post:read`. Unlike the single-item `marketplacePost(id)`
   * above (unchanged, still ungated - Module 11's mobile app already calls
   * it), this is a genuinely new operation with no employee-facing
   * consumer to preserve compatibility with.
   */
  @Query(() => [MarketplacePostResult], { name: 'marketplacePosts' })
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_post:read')
  async marketplacePosts(
    @Args('orgUnitId', { type: () => ID }) orgUnitId: string,
    @Args('status', { type: () => String, nullable: true }) status?: string,
  ): Promise<MarketplacePostResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const posts = await this.postQuery.listByOrgUnit(tenantId, orgUnitId, status as MarketplacePostStatus | undefined);
    return posts.map(toMarketplacePostResult);
  }

  @Mutation(() => ClaimOpenShiftResultType)
  async claimOpenShift(@Args('postId', { type: () => ID }) postId: string): Promise<ClaimOpenShiftResultType> {
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.requireActorId();
    const { claim, post } = await this.claimOpenShiftService.claim(tenantId, postId, actorId);
    return { claim: toMarketplaceClaimResult(claim), post: toMarketplacePostResult(post) };
  }

  /**
   * §3.1: `tenantId` is an explicit argument, not read from
   * `TenantContextService` - a `graphql-ws` subscription connection doesn't
   * reliably carry the HTTP-header-bound context (same limitation
   * intraday-service's own `alertRaised` subscription documents), so the
   * trigger has to be keyed off something the client passes explicitly.
   */
  @Subscription(() => MarketplacePostResult, { name: 'marketplacePostUpdated' })
  marketplacePostUpdated(
    @Args('tenantId', { type: () => ID }) tenantId: string,
    @Args('orgUnitId', { type: () => ID }) orgUnitId: string,
  ): AsyncIterator<unknown> {
    return this.pubSub.asyncIterator(marketplacePostUpdatedTrigger(tenantId, orgUnitId));
  }

  /**
   * §3.1's own design rule: calls the *same* guardrail path a real claim
   * attempt would (`MarketplacePostQueryService.isEligibleFor`), read-only.
   * Defensively returns `false` (never throws) when no actor context is
   * bound - the one case that matters in practice is a
   * `marketplacePostUpdated` subscription delivery, whose `graphql-ws`
   * connection carries no `X-Actor-Id` (same limitation as `tenantId`
   * above); a push event about a status *change* is still useful to a
   * client even when this one field can't be resolved for it, so this
   * degrades gracefully rather than breaking the whole subscription
   * stream - a known, flagged limitation, not a fabricated `true`/`false`.
   */
  @ResolveField(() => Boolean)
  async eligibleForMe(@Parent() post: MarketplacePostResult): Promise<boolean> {
    let tenantId: string;
    let actorId: string;
    try {
      tenantId = this.tenantContext.requireTenantId();
      actorId = this.tenantContext.requireActorId();
    } catch {
      return false;
    }
    const outcome = await this.guardrailValidation.checkEligibility({
      tenantId,
      candidateEmployeeId: actorId,
      shiftAssignmentId: post.shiftAssignmentId,
      orgUnitId: post.orgUnitId,
    });
    return outcome.shiftAssignmentFound && outcome.eligible;
  }

  /**
   * Shift Marketplace Manager View phase, §4: null for every post except a
   * `BID`-type one with an opportunity already created - never throws for a
   * post with no opportunity yet, since that's an ordinary, expected state
   * (the opportunity is created separately from the post itself), not an
   * error.
   */
  @ResolveField(() => ID, { nullable: true })
  async bidOpportunityId(@Parent() post: MarketplacePostResult): Promise<string | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const opportunity = await this.bidOpportunityService.findByMarketplacePostId(tenantId, post.id);
    return opportunity?.id ?? null;
  }
}

export function toMarketplacePostResult(post: MarketplacePost): MarketplacePostResult {
  return {
    id: post.id,
    postType: post.postType,
    shiftAssignmentId: post.shiftAssignmentId,
    orgUnitId: post.orgUnitId,
    status: post.status,
    expiresAt: post.expiresAt,
    eligibleForMe: false,
    bidOpportunityId: null,
  };
}

export function toMarketplaceClaimResult(claim: MarketplaceClaim) {
  return {
    id: claim.id,
    claimantEmployeeId: claim.claimantEmployeeId,
    status: claim.status,
    source: claim.source,
    validationResult: claim.validationResult,
    claimedAt: claim.claimedAt,
    decisionReason: claim.decisionReason,
  };
}
