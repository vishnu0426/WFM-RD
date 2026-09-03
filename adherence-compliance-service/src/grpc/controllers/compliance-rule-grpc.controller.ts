import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ComplianceRuleService } from '../../compliance/compliance-rule.service';
import { ComplianceRuleType } from '../../compliance/entities/compliance-rule.entity';
import { validatePolicyAgainstFloor } from '../../compliance/validate-policy-against-floor';

interface GetActiveRuleRequest {
  tenantId: string;
  jurisdiction: string;
  ruleType: string;
  asOf: string;
}

interface ComplianceRuleResponse {
  found: boolean;
  id: string;
  jurisdiction: string;
  ruleType: string;
  definitionJson: string;
  effectiveFrom: string;
  effectiveTo: string;
  version: number;
  citation: string;
  isPlatformDefault: boolean;
}

interface ValidatePolicyAgainstFloorRequest {
  tenantId: string;
  jurisdiction: string;
  ruleType: string;
  policyDefinitionJson: string;
}

interface ValidatePolicyAgainstFloorResponse {
  valid: boolean;
  violations: string[];
  floorNotFound: boolean;
}

const RULE_NOT_FOUND: ComplianceRuleResponse = {
  found: false,
  id: '',
  jurisdiction: '',
  ruleType: '',
  definitionJson: '',
  effectiveFrom: '',
  effectiveTo: '',
  version: 0,
  citation: '',
  isPlatformDefault: false,
};

/**
 * §3.3/§0.6/ADR-0100: `ComplianceRuleService` - Module 08's first gRPC
 * server. Tenant context has no HTTP middleware to bind it here (same
 * ADR-0021 posture every other internal gRPC controller in this platform
 * follows) - bound explicitly from each request message's own `tenant_id`.
 */
@Controller()
export class ComplianceRuleGrpcController {
  private readonly logger = new Logger(ComplianceRuleGrpcController.name);

  constructor(private readonly complianceRuleService: ComplianceRuleService) {}

  @GrpcMethod('ComplianceRuleService', 'GetActiveRule')
  async getActiveRule(request: GetActiveRuleRequest): Promise<ComplianceRuleResponse> {
    if (!Object.values(ComplianceRuleType).includes(request.ruleType as ComplianceRuleType)) {
      this.logger.warn(`GetActiveRule called with unknown rule_type="${request.ruleType}"`);
      return RULE_NOT_FOUND;
    }
    const asOf = request.asOf ? new Date(request.asOf) : new Date();
    const rule = await this.complianceRuleService.getActiveRule(
      request.tenantId,
      request.jurisdiction,
      request.ruleType as ComplianceRuleType,
      asOf,
    );
    if (!rule) {
      return RULE_NOT_FOUND;
    }
    return {
      found: true,
      id: rule.id,
      jurisdiction: rule.jurisdiction,
      ruleType: rule.ruleType,
      definitionJson: JSON.stringify(rule.definition),
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo ?? '',
      version: rule.version,
      citation: rule.citation,
      isPlatformDefault: rule.tenantId === null,
    };
  }

  /**
   * §0.6's write-time gate. `floorNotFound: true` (no ComplianceRule exists
   * for this jurisdiction/ruleType yet) always comes back `valid: true` -
   * a floor this module hasn't encoded cannot reject a write, per §0.6's
   * own framing of the floor as a minimum, not a universal blocker
   * (ADR-0100).
   */
  @GrpcMethod('ComplianceRuleService', 'ValidatePolicyAgainstFloor')
  async validatePolicyAgainstFloor(
    request: ValidatePolicyAgainstFloorRequest,
  ): Promise<ValidatePolicyAgainstFloorResponse> {
    if (!Object.values(ComplianceRuleType).includes(request.ruleType as ComplianceRuleType)) {
      this.logger.warn(`ValidatePolicyAgainstFloor called with unknown rule_type="${request.ruleType}"`);
      return { valid: true, violations: [], floorNotFound: true };
    }
    const ruleType = request.ruleType as ComplianceRuleType;
    const floor = await this.complianceRuleService.getActiveRule(
      request.tenantId,
      request.jurisdiction,
      ruleType,
      new Date(),
    );
    if (!floor) {
      return { valid: true, violations: [], floorNotFound: true };
    }

    let policyDefinition: Record<string, unknown>;
    try {
      policyDefinition = JSON.parse(request.policyDefinitionJson);
    } catch {
      return { valid: false, violations: ['policy_definition_json is not valid JSON'], floorNotFound: false };
    }

    const result = validatePolicyAgainstFloor(ruleType, policyDefinition, floor.definition);
    return { ...result, floorNotFound: false };
  }
}
