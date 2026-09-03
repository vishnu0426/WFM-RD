import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AiProviderConfigService } from '../../ai/ai-provider-config.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiLlmProvider } from '../../ai/entities/ai-provider-config.entity';
import {
  AiProviderConfigHistoryResult,
  AiProviderConfigSummaryResult,
  toAiProviderConfigHistoryResult,
} from '../../ai/provider-config-types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * docs/adr/0117/0130. `configureAiProvider` sets/rotates a tenant's LLM API
 * key - at least as sensitive as any other RBAC-gated write in this
 * platform, and now actually gated: `AccessTokenGuard` + `PermissionsGuard`
 * + `TenantTokenMatchGuard` (own copies of core's real, already-implemented
 * RBAC guards, not a fabricated placeholder - docs/adr/0130/0133) require a
 * valid token carrying `ai_provider_config:write`, cross-checked against
 * this request's own tenant context. `aiProviderConfig`/
 * `aiProviderConfigHistory` (reads) stay ungated - reading back "which
 * provider/model this tenant already configured, and its own history"
 * (never the key itself) is no more sensitive than any other tenant-scoped
 * read in this service.
 */
@Resolver(() => AiProviderConfigSummaryResult)
export class AiProviderConfigResolver {
  constructor(
    private readonly aiProviderConfigService: AiProviderConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Query(() => AiProviderConfigSummaryResult, { name: 'aiProviderConfig', nullable: true })
  async aiProviderConfig(): Promise<AiProviderConfigSummaryResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    return this.aiProviderConfigService.getSummary(tenantId);
  }

  /**
   * docs/adr/0129: `apiKey`/`baseUrl` are both optional at the GraphQL
   * layer - `AiProviderConfigService.configure` (not this resolver) is
   * where "which one is actually required for this provider" is enforced,
   * since that rule depends on the provider argument's own value, not
   * something a GraphQL-level `!` can express across four provider choices.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_provider_config:write')
  @Mutation(() => AiProviderConfigSummaryResult)
  async configureAiProvider(
    @Args('provider', { type: () => AiLlmProvider }) provider: AiLlmProvider,
    @Args('model') model: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
    @Args('apiKey', { nullable: true }) apiKey?: string,
    @Args('baseUrl', { nullable: true }) baseUrl?: string,
  ): Promise<AiProviderConfigSummaryResult> {
    const tenantId = this.tenantContext.requireTenantId();
    // updatedBy: the token's own verified `sub` - a real authenticated
    // identity, not the `null` placeholder every prior phase's own doc
    // comment named (no Module 01 IdentityService.GetUserContext gRPC call
    // was needed once a verified JWT already carries this).
    return this.aiProviderConfigService.configure(
      tenantId,
      provider,
      model,
      apiKey ?? null,
      baseUrl ?? null,
      claims.sub ?? null,
    );
  }

  /** ADR-0132: newest-first, includes the currently active version (`validTo: null`); never the key. Ungated, same posture as `aiProviderConfig` itself. */
  @Query(() => [AiProviderConfigHistoryResult], { name: 'aiProviderConfigHistory' })
  async aiProviderConfigHistory(): Promise<AiProviderConfigHistoryResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const history = await this.aiProviderConfigService.getHistory(tenantId);
    return history.map(toAiProviderConfigHistoryResult);
  }
}
