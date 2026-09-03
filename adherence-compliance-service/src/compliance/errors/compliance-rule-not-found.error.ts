import { DomainError } from '../../common/errors/domain-error';

export class ComplianceRuleNotFoundError extends DomainError {
  constructor(ruleId: string) {
    super('COMPLIANCE_RULE_NOT_FOUND', `Compliance rule ${ruleId} was not found.`);
  }
}
