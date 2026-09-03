import { DomainError } from '../../../common/errors/domain-error';

export class Five9ApiError extends DomainError {
  constructor(cause: string) {
    super('FIVE9_API_ERROR', `Five9 API call failed: ${cause}`);
  }
}
