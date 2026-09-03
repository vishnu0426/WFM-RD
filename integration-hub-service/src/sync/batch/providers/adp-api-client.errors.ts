import { DomainError } from '../../../common/errors/domain-error';

export class AdpApiError extends DomainError {
  constructor(cause: string) {
    super('ADP_API_ERROR', `ADP API call failed: ${cause}`);
  }
}
