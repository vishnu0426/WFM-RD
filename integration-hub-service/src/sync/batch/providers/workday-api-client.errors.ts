import { DomainError } from '../../../common/errors/domain-error';

export class WorkdayApiError extends DomainError {
  constructor(cause: string) {
    super('WORKDAY_API_ERROR', `Workday API call failed: ${cause}`);
  }
}
