import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ComplianceRuleService } from './compliance-rule.service';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { toComplianceRuleResult, ComplianceRuleResult } from './types';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

/**
 * §3.2: `GET /v1/compliance/rules/{jurisdiction}` - "the REST-equivalent of
 * the gRPC contract Module 04 uses; keep the two in sync as one canonical
 * rule representation." Returns what is actually in effect right now, one
 * row per `ruleType` (`resolveEffectiveRules`) - the GraphQL
 * `complianceRules(jurisdiction)` query is the separate, broader admin
 * management view (every status, not resolved to one-per-type).
 *
 * ADR-0161: gated with `compliance_rule:read`, same permission the GraphQL
 * `complianceRules` query now requires - Module 04's own gRPC call to
 * `ComplianceRuleService.GetActiveRule` doesn't go through this REST
 * endpoint at all (a separate, unauthenticated-by-design internal gRPC
 * surface, out of this ADR's scope), so gating this one is safe.
 */
@Controller('v1/compliance')
export class ComplianceRuleController {
  constructor(
    private readonly complianceRuleService: ComplianceRuleService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_rule:read')
  @Get('rules/:jurisdiction')
  async getEffectiveRules(@Param('jurisdiction') jurisdiction: string): Promise<ComplianceRuleResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rules = await this.complianceRuleService.findEffectiveRules(tenantId, jurisdiction);
    return rules.map(toComplianceRuleResult);
  }
}
