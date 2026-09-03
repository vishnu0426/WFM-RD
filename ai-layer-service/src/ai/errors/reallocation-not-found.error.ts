import { DomainError } from '../../common/errors/domain-error';

export class ReallocationNotFoundError extends DomainError {
  constructor(reallocationActionId: string) {
    super(
      'REALLOCATION_NOT_FOUND',
      `No reallocation action with id "${reallocationActionId}" was found for this tenant.`,
    );
  }
}
