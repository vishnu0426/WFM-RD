import { DomainError } from '../../common/errors/domain-error';

export class DashboardNotFoundError extends DomainError {
  constructor(id: string) {
    super('DASHBOARD_NOT_FOUND', `No dashboard "${id}" found for this tenant.`);
  }
}
