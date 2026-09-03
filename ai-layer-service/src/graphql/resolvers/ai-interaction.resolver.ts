import { UseGuards } from '@nestjs/common';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { AiInteractionQueryService } from '../../ai/ai-interaction-query.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiInteractionType } from '../../ai/entities/ai-interaction.entity';
import { AiInteractionResult, toAiInteractionResult } from '../../ai/types';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

/**
 * `aiInteractions` - gated on `ai_interaction:read`, a permission already
 * seeded (core's `run-seed.ts`, bound to `platform_admin`/`tenant_admin`)
 * but never checked by any resolver until now; distinct from
 * `ai_interaction:write`, which gates the five LLM-call-incurring generator
 * queries (docs/adr/0133) - this is a plain DB read with no LLM cost, so it
 * deliberately does NOT carry `AiInteractionRateLimitGuard`.
 *
 * Tenant-scoped like every other query in this service (`TenantContextService.
 * requireTenantId()` / RLS) - "admin-wide" here means across interaction
 * types and org units within a tenant, not a cross-tenant capability this
 * codebase doesn't have anywhere else.
 */
@Resolver(() => AiInteractionResult)
export class AiInteractionResolver {
  constructor(
    private readonly aiInteractionQuery: AiInteractionQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_interaction:read')
  @Query(() => [AiInteractionResult], { name: 'aiInteractions' })
  async aiInteractions(
    @Args('interactionType', { type: () => AiInteractionType, nullable: true }) interactionType?: AiInteractionType,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<AiInteractionResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const interactions = await this.aiInteractionQuery.list(tenantId, { interactionType, limit, offset });
    return interactions.map(toAiInteractionResult);
  }
}
