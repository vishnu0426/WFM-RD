import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { RootCauseAnalysisService } from '../../ai/root-cause-analysis.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../../auth/ai-interaction-rate-limit.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §9 Phase 4's own literal name ("root_cause_analysis") - same "not pinned
 * down by §6.1, name it consistently ourselves" posture as
 * `ReallocationRationaleResolver`. RBAC-gated since Phase 9
 * (`ai_interaction:write`, docs/adr/0133).
 */
@Resolver(() => AiInteractionResult)
export class RootCauseAnalysisResolver {
  constructor(
    private readonly rootCauseAnalysisService: RootCauseAnalysisService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, AiInteractionRateLimitGuard)
  @RequirePermissions('ai_interaction:write')
  @Query(() => AiInteractionResult, { name: 'rootCauseAnalysis' })
  async rootCauseAnalysis(
    @Args('orgUnitId', { type: () => ID }) orgUnitId: string,
    @Args('periodStart', { type: () => Date }) periodStart: Date,
    @Args('periodEnd', { type: () => Date }) periodEnd: Date,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiInteractionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const interaction = await this.rootCauseAnalysisService.analyzeRootCause(
      tenantId,
      claims.sub ?? null,
      orgUnitId,
      periodStart,
      periodEnd,
    );
    return toAiInteractionResult(interaction);
  }
}
