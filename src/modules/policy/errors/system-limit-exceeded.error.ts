import { DomainError } from '../../../common/errors/domain-error';

/** System Configuration's System Limits — a tenant has reached its configured maximum for `kind`. */
export class SystemLimitExceededError extends DomainError {
  readonly code = 'SYSTEM_LIMIT_EXCEEDED';

  constructor(kind: string, limit: number) {
    super(`This tenant has reached its configured limit of ${limit} for ${kind}.`, { kind, limit });
  }
}
