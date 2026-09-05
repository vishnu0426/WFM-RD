import { DomainError } from '../../common/errors/domain-error';

export class IntegrationServerNotFoundError extends DomainError {
  constructor(id: string) {
    super('INTEGRATION_SERVER_NOT_FOUND', `No IntegrationServer found with id "${id}" for this tenant.`);
  }
}
