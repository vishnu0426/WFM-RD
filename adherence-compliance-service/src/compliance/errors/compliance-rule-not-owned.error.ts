import { DomainError } from '../../common/errors/domain-error';

/**
 * ADR-0095/0097: a tenant may only activate a rule it created itself -
 * never a platform-default row (`tenantId === null`) and never another
 * tenant's row. Postgres RLS's own `WITH CHECK` already makes the
 * corresponding `UPDATE` structurally impossible either way (verified
 * against a real instance in Phase 1) - this check exists so the caller
 * gets a clean typed error instead of a raw RLS-violation exception.
 */
export class ComplianceRuleNotOwnedError extends DomainError {
  constructor(ruleId: string) {
    super('COMPLIANCE_RULE_NOT_OWNED', `Compliance rule ${ruleId} is not owned by this tenant and cannot be modified.`);
  }
}
