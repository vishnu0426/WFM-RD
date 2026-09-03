import { DomainError } from '../../common/errors/domain-error';

export class FieldMappingAuthorityNotApplicableError extends DomainError {
  constructor() {
    super(
      'FIELD_MAPPING_AUTHORITY_NOT_APPLICABLE',
      'authority is not applicable to connector_type: acd (§2.2 rule 5) - ACD ingestion is one-directional and has nothing to conflict against.',
    );
  }
}
