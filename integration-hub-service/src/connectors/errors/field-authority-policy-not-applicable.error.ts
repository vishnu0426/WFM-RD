import { DomainError } from '../../common/errors/domain-error';

export class FieldAuthorityPolicyNotApplicableError extends DomainError {
  constructor() {
    super(
      'FIELD_AUTHORITY_POLICY_NOT_APPLICABLE',
      'FieldAuthorityPolicy does not apply to connector_type: acd (§2.2 rule 5) - ACD ingestion is one-directional and has nothing to conflict against.',
    );
  }
}
