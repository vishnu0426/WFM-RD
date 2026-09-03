import { DomainError } from '../../../common/errors/domain-error';

export class SalesforceApiError extends DomainError {
  constructor(cause: string) {
    super('SALESFORCE_API_ERROR', `Salesforce API call failed: ${cause}`);
  }
}
