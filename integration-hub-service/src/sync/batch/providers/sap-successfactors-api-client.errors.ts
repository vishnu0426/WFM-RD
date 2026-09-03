import { DomainError } from '../../../common/errors/domain-error';

export class SapSuccessFactorsApiError extends DomainError {
  constructor(cause: string) {
    super('SAP_SUCCESSFACTORS_API_ERROR', `SAP SuccessFactors API call failed: ${cause}`);
  }
}
