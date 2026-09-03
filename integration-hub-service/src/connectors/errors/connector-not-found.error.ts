import { DomainError } from '../../common/errors/domain-error';

export class ConnectorNotFoundError extends DomainError {
  constructor(connectorId: string) {
    super('CONNECTOR_NOT_FOUND', `No IntegrationConnector found with id "${connectorId}" for this tenant.`);
  }
}
