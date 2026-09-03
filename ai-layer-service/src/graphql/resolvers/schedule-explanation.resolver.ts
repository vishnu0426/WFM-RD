import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { ScheduleExplanationService } from '../../ai/schedule-explanation.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../../auth/ai-interaction-rate-limit.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §6.1: `explainSchedule(scheduleId)`. Named per the spec's own literal
 * query name - the argument is a schedule JOB id (§2's `ScheduleJob`/
 * `ScheduleExplanation` both key off `schedule_job_id`), not a published
 * `Schedule` id; no separate published schedule exists to explain
 * otherwise. RBAC-gated since Phase 9 (docs/adr/0133) with
 * `ai_interaction:write` - a `Query` in GraphQL terms, but it persists a
 * new `AIInteraction` row and incurs a real LLM API cost, the same
 * FinOps-relevant "write" every operation in this resource is gated on.
 */
@Resolver(() => AiInteractionResult)
export class ScheduleExplanationResolver {
  constructor(
    private readonly scheduleExplanationService: ScheduleExplanationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, AiInteractionRateLimitGuard)
  @RequirePermissions('ai_interaction:write')
  @Query(() => AiInteractionResult, { name: 'explainSchedule' })
  async explainSchedule(
    @Args('scheduleId', { type: () => ID }) scheduleId: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiInteractionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const interaction = await this.scheduleExplanationService.explainSchedule(tenantId, claims.sub ?? null, scheduleId);
    return toAiInteractionResult(interaction);
  }
}
