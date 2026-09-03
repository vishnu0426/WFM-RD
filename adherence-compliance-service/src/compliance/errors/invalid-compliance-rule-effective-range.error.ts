import { DomainError } from '../../common/errors/domain-error';

export class InvalidComplianceRuleEffectiveRangeError extends DomainError {
  constructor() {
    super('INVALID_COMPLIANCE_RULE_EFFECTIVE_RANGE', 'effectiveTo must not be before effectiveFrom.');
  }
}
