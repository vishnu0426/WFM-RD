import { DomainError } from '../../common/errors/domain-error';

export class InvalidConnectorSettingsError extends DomainError {
  constructor(message: string) {
    super('INVALID_CONNECTOR_SETTINGS', message);
  }
}
