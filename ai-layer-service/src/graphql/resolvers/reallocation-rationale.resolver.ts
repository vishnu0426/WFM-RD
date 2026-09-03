import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { ReallocationRationaleService } from '../../ai/reallocation-rationale.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../../auth/ai-interaction-rate-limit.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §9 Phase 4's own literal name ("reallocationRationale") - not a query
 * name §6.1 itself pins down (only `explainSchedule`/`explainForecast`/
 * `pendingRecommendations` are named there), so this resolver names its
 * query `explainReallocation` for consistency with the other two `explain*`
 * queries this module already exposes. RBAC-gated since Phase 9
 * (`ai_interaction:write`, docs/adr/0133).
 */
@Resolver(() => AiInteractionResult)
export class ReallocationRationaleResolver {
  constructor(
    private readonly reallocationRationaleService: ReallocationRationaleService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, AiInteractionRateLimitGuard)
  @RequirePermissions('ai_interaction:write')
  @Query(() => AiInteractionResult, { name: 'explainReallocation' })
  async explainReallocation(
    @Args('reallocationActionId', { type: () => ID }) reallocationActionId: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiInteractionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const interaction = await this.reallocationRationaleService.explainReallocation(
      tenantId,
      claims.sub ?? null,
      reallocationActionId,
    );
    return toAiInteractionResult(interaction);
  }
}
