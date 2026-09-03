import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AiGovernancePolicyService } from '../../ai/ai-governance-policy.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AiAutonomyLevel } from '../../ai/entities/ai-governance-policy.entity';
import {
  AiGovernancePolicyHistoryResult,
  AiGovernancePolicyResult,
  toAiGovernancePolicyHistoryResult,
  toAiGovernancePolicyResult,
} from '../../ai/governance-policy-types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §6.1: `updateGovernancePolicy` - "admin-only, per Module 01 RBAC" in the
 * spec's own words. Now RBAC-gated for real (docs/adr/0130/0133):
 * `AccessTokenGuard` + `PermissionsGuard` + `TenantTokenMatchGuard` require
 * a valid token carrying `ai_governance_policy:write`, cross-checked
 * against this request's own tenant context - setting a tenant's autonomy
 * level (including enabling `auto_execute_low_risk`) is exactly the kind
 * of write this platform's own real RBAC mechanism (core's
 * `PermissionsGuard`/`@RequirePermissions`, `docs/adr/0035`) already exists
 * to gate. `aiGovernancePolicyHistory` (read) stays ungated, same posture
 * as every other read in this service.
 */
@Resolver(() => AiGovernancePolicyResult)
export class AiGovernancePolicyResolver {
  constructor(
    private readonly aiGovernancePolicyService: AiGovernancePolicyService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('ai_governance_policy:write')
  @Mutation(() => AiGovernancePolicyResult)
  async updateGovernancePolicy(
    @Args('actionType') actionType: string,
    @Args('autonomyLevel', { type: () => AiAutonomyLevel }) autonomyLevel: AiAutonomyLevel,
    @CurrentTokenClaims() claims: AccessTokenClaims,
    @Args('riskThresholdConfig', { type: () => Object, nullable: true }) riskThresholdConfig?: Record<string, unknown>,
  ): Promise<AiGovernancePolicyResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const policy = await this.aiGovernancePolicyService.update(
      tenantId,
      actionType,
      autonomyLevel,
      riskThresholdConfig ?? {},
      claims.sub ?? null,
    );
    return toAiGovernancePolicyResult(policy);
  }

  /** ADR-0132: newest-first, includes the currently active version (`validTo: null`) - ungated, same posture as `aiProviderConfig`'s own read (reading history is no more sensitive than reading the current value). */
  @Query(() => [AiGovernancePolicyHistoryResult], { name: 'aiGovernancePolicyHistory' })
  async aiGovernancePolicyHistory(@Args('actionType') actionType: string): Promise<AiGovernancePolicyHistoryResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const history = await this.aiGovernancePolicyService.getHistory(tenantId, actionType);
    return history.map(toAiGovernancePolicyHistoryResult);
  }
}
