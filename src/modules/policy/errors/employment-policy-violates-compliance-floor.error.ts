import { DomainError } from '../../../common/errors/domain-error';

/**
 * §0.6/ADR-0101: `EmploymentPoliciesService.create`'s write-time gate -
 * thrown when Module 08's `ComplianceRuleService.ValidatePolicyAgainstFloor`
 * reports the proposed policy is less protective than the jurisdiction's
 * legal floor. Never thrown when no floor exists for that jurisdiction/
 * ruleType (`floorNotFound: true`) - a floor this platform hasn't encoded
 * yet cannot reject a write for failing to meet it.
 */
export class EmploymentPolicyViolatesComplianceFloorError extends DomainError {
  readonly code = 'EMPLOYMENT_POLICY_VIOLATES_COMPLIANCE_FLOOR';

  constructor(jurisdiction: string, violations: string[]) {
    super(`This policy is less protective than ${jurisdiction}'s legal floor: ${violations.join('; ')}.`, {
      jurisdiction,
      violations,
    });
  }
}
