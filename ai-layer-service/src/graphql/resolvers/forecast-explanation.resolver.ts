import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { ForecastExplanationService } from '../../ai/forecast-explanation.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../../auth/ai-interaction-rate-limit.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/** §6.1: `explainForecast(forecastRunId)` - Phase 4, own copy of `ScheduleExplanationResolver`'s shape, including its Phase 9 RBAC gate (`ai_interaction:write`, docs/adr/0133). */
@Resolver(() => AiInteractionResult)
export class ForecastExplanationResolver {
  constructor(
    private readonly forecastExplanationService: ForecastExplanationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, AiInteractionRateLimitGuard)
  @RequirePermissions('ai_interaction:write')
  @Query(() => AiInteractionResult, { name: 'explainForecast' })
  async explainForecast(
    @Args('forecastRunId', { type: () => ID }) forecastRunId: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiInteractionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const interaction = await this.forecastExplanationService.explainForecast(
      tenantId,
      claims.sub ?? null,
      forecastRunId,
    );
    return toAiInteractionResult(interaction);
  }
}
