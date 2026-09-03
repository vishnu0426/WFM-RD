import { DomainError } from '../../common/errors/domain-error';

/** §2.2 rule 2: application-layer defense in depth ahead of the schema's own `compliance_rule_citation_required_check` - a clean typed error instead of a raw Postgres constraint-violation bubbling up. */
export class ComplianceRuleCitationRequiredError extends DomainError {
  constructor() {
    super('COMPLIANCE_RULE_CITATION_REQUIRED', 'citation must be a non-empty legal reference.');
  }
}
