import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ComplianceRuleService } from '../../compliance/compliance-rule.service';
import { RuleChangeImpactPreviewService } from '../../compliance/impact-preview/rule-change-impact-preview.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import {
  ComplianceRuleResult,
  CreateComplianceRuleInput,
  RuleChangeImpactPreviewResult,
  toComplianceRuleResult,
  toRuleChangeImpactPreviewResult,
} from '../../compliance/types';

/**
 * ADR-0161: every operation here was previously open to any caller with a
 * valid tenant header - this module's own docs called that out explicitly
 * as "no RBAC/permission check anywhere in the module." Gated now with
 * this platform's standard guard trio, reusing the `compliance_rule`
 * resource/permission pair (`:read`/`:write`) rather than inventing new
 * action names - `generateRuleChangeImpactPreview` gets `:write` too since
 * it persists a new `RuleChangeImpactPreview` row, the same "any mutation
 * on this resource" grouping `integration_connector:write` already covers
 * across create/activate in integration-hub-service.
 */
@Resolver(() => ComplianceRuleResult)
export class ComplianceRuleResolver {
  constructor(
    private readonly complianceRuleService: ComplianceRuleService,
    private readonly ruleChangeImpactPreviewService: RuleChangeImpactPreviewService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** §3.1: the admin management view - every rule visible to this tenant for this jurisdiction, any status, not resolved to one-per-`ruleType`. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_rule:read')
  @Query(() => [ComplianceRuleResult], { name: 'complianceRules' })
  async complianceRules(@Args('jurisdiction') jurisdiction: string): Promise<ComplianceRuleResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rules = await this.complianceRuleService.listRules(tenantId, jurisdiction);
    return rules.map(toComplianceRuleResult);
  }

  /** §5a: lands in `pending_review`, never active on creation - see `ComplianceRuleService.createRule`'s own doc comment. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_rule:write')
  @Mutation(() => ComplianceRuleResult)
  async createComplianceRule(@Args('input') input: CreateComplianceRuleInput): Promise<ComplianceRuleResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const rule = await this.complianceRuleService.createRule(tenantId, input);
    return toComplianceRuleResult(rule);
  }

  /**
   * §5a's separate, explicit go-live step. `effectiveAt` is §0.5's
   * progressive-delivery field (`activationDelayUntil` in the schema) -
   * omit it for immediate effect once approved. Phase 5 (docs/adr/0104):
   * now requires at least one `RuleChangeImpactPreview` to already exist
   * for `ruleId` - throws `ImpactPreviewRequiredError` otherwise.
   * `justificationNote`: required whenever that preview flagged
   * non-compliant schedules - throws `ActivationJustificationRequiredError`
   * otherwise; see `ComplianceRuleService.activateRule`'s own doc comment.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_rule:write')
  @Mutation(() => ComplianceRuleResult)
  async activateComplianceRule(
    @Args('ruleId', { type: () => ID }) ruleId: string,
    @Args('effectiveAt', { type: () => Date, nullable: true }) effectiveAt?: Date,
    @Args('justificationNote', { type: () => String, nullable: true }) justificationNote?: string,
  ): Promise<ComplianceRuleResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const rule = await this.complianceRuleService.activateRule(tenantId, ruleId, effectiveAt, justificationNote);
    return toComplianceRuleResult(rule);
  }

  /**
   * §5a/docs/adr/0104: re-runs `ruleId`'s constraint check against every
   * currently-published shift assignment for `orgUnitIds`' schedulable
   * rosters, over the next 28 days. `orgUnitIds` is caller-supplied, not
   * resolved from the rule's own `jurisdiction` - see
   * `RuleChangeImpactPreviewService`'s own doc comment for why. No REST
   * equivalent - GraphQL is this service's primary mutation surface,
   * matching `createComplianceRule`/`activateComplianceRule`'s own
   * GraphQL-only precedent.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_rule:write')
  @Mutation(() => RuleChangeImpactPreviewResult)
  async generateRuleChangeImpactPreview(
    @Args('ruleId', { type: () => ID }) ruleId: string,
    @Args('orgUnitIds', { type: () => [ID] }) orgUnitIds: string[],
  ): Promise<RuleChangeImpactPreviewResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const preview = await this.ruleChangeImpactPreviewService.generatePreview(tenantId, ruleId, orgUnitIds);
    return toRuleChangeImpactPreviewResult(preview);
  }
}
