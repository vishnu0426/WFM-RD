import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { AskQuestionService } from '../../ai/ask-question.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AskQuestionContextInput } from '../inputs/ask-question-context.input';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { AiInteractionRateLimitGuard } from '../../auth/ai-interaction-rate-limit.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §6.1/§9 Phase 6: `askQuestion(context, question)` - kept a `Query`, same
 * as `explainSchedule`/`explainForecast`/`explainReallocation`/
 * `rootCauseAnalysis`, all of which also produce and persist a new
 * `AIInteraction` row despite being read operations from the caller's own
 * point of view (they never mutate any pre-existing resource - only
 * `createReallocationRecommendation`/`decideRecommendation`/
 * `updateGovernancePolicy`/`configureAiProvider` are `Mutation`s in this
 * module, each because they change a pre-existing resource's state).
 * RBAC-gated since Phase 9 (`ai_interaction:write`, docs/adr/0133) - the
 * same permission every other `AIInteraction`-generating query requires.
 */
@Resolver(() => AiInteractionResult)
export class AskQuestionResolver {
  constructor(
    private readonly askQuestionService: AskQuestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, AiInteractionRateLimitGuard)
  @RequirePermissions('ai_interaction:write')
  @Query(() => AiInteractionResult, { name: 'askQuestion' })
  async askQuestion(
    @Args('question') question: string,
    @Args('context') context: AskQuestionContextInput,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AiInteractionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const interaction = await this.askQuestionService.askQuestion(tenantId, claims.sub ?? null, question, context);
    return toAiInteractionResult(interaction);
  }
}
