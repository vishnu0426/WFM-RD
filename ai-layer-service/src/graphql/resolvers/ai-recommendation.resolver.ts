import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AiRecommendationService } from '../../ai/ai-recommendation.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  AiRecommendationDecision,
  AiRecommendationResult,
  toAiRecommendationResult,
} from '../../ai/recommendation-types';
import {
  AiRecommendationSourceModule,
  AiRecommendationStatus,
} from '../../ai/entities/ai-recommendation.entity';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §6.1: `pendingRecommendations(orgUnitId)`, `decideRecommendation`.
 * `createReallocationRecommendation` isn't named in §6.1 (it names no
 * recommendation-creation mutation at all) - added as this module's own
 * real entry point, the same "not pinned down, name it consistently"
 * posture `explainReallocation`/`rootCauseAnalysis` already took.
 *
 * RBAC-gated since Phase 9 (docs/adr/0133) with three distinct
 * `ai_recommendation:*` permissions, not one shared permission: `:read`
 * for listing, `:write` for creating, and `:approve` for deciding - the
 * same `backdated_leave_entry:approve` precedent (Module 06 Phase 6) of
 * giving a consequential approve/reject action its own grantable
 * permission, separate from the ability to create the thing being decided.
 */
@Resolver(() => AiRecommendationResult)
export class AiRecommendationResolver {
  constructor(
    private readonly aiRecommendationService: AiRecommendationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_recommendation:read')
  @Query(() => [AiRecommendationResult], { name: 'pendingRecommendations' })
  async pendingRecommendations(
    @Args('orgUnitId', { type: () => ID, nullable: true }) orgUnitId?: string,
  ): Promise<AiRecommendationResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const recommendations = await this.aiRecommendationService.listPending(tenantId, orgUnitId);
    return recommendations.map(toAiRecommendationResult);
  }

  /** `listPending`'s general-purpose sibling - no hardcoded `status = SUGGESTED` filter, paginated, for an admin history view (any status/org unit/source module within this tenant) rather than a supervisor's live approval queue. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_recommendation:read')
  @Query(() => [AiRecommendationResult], { name: 'aiRecommendations' })
  async aiRecommendations(
    @Args('status', { type: () => AiRecommendationStatus, nullable: true }) status?: AiRecommendationStatus,
    @Args('orgUnitId', { type: () => ID, nullable: true }) orgUnitId?: string,
    @Args('sourceModule', { type: () => AiRecommendationSourceModule, nullable: true })
    sourceModule?: AiRecommendationSourceModule,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<AiRecommendationResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const recommendations = await this.aiRecommendationService.list(tenantId, {
      status,
      orgUnitId,
      sourceModule,
      limit,
      offset,
    });
    return recommendations.map(toAiRecommendationResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_recommendation:write')
  @Mutation(() => AiRecommendationResult)
  async createReallocationRecommendation(
    @Args('aiInteractionId', { type: () => ID }) aiInteractionId: string,
  ): Promise<AiRecommendationResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const recommendation = await this.aiRecommendationService.createFromInteraction(tenantId, aiInteractionId);
    return toAiRecommendationResult(recommendation);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_recommendation:approve')
  @Mutation(() => AiRecommendationResult)
  async decideRecommendation(
    @Args('recommendationId', { type: () => ID }) recommendationId: string,
    @Args('decision', { type: () => AiRecommendationDecision }) decision: AiRecommendationDecision,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiRecommendationResult> {
    const tenantId = this.tenantContext.requireTenantId();
    // The GraphQL enum's runtime value is the same 'approved'/'rejected'
    // literal `RecommendationDecision` expects - cast at this one boundary
    // rather than having the domain service depend on a GraphQL-layer type.
    const recommendation = await this.aiRecommendationService.decideRecommendation(
      tenantId,
      claims.sub ?? null,
      recommendationId,
      decision as unknown as 'approved' | 'rejected',
    );
    return toAiRecommendationResult(recommendation);
  }
}
