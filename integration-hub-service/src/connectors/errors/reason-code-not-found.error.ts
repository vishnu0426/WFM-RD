import { DomainError } from '../../common/errors/domain-error';

export class ReasonCodeNotFoundError extends DomainError {
  constructor(id: string) {
    super('REASON_CODE_NOT_FOUND', `No ReasonCode found with id "${id}" for this tenant.`);
  }
}
