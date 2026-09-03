import { DomainError } from '../../common/errors/domain-error';

/** Application-layer defense in depth ahead of the schema's own `retention_policy_years_positive_check`. */
export class InvalidRetentionYearsError extends DomainError {
  constructor(retentionYears: number) {
    super('INVALID_RETENTION_YEARS', `retentionYears must be a positive integer, got ${retentionYears}.`);
  }
}
