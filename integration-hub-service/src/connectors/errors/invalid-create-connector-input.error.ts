import { DomainError } from '../../common/errors/domain-error';

export class InvalidCreateConnectorInputError extends DomainError {
  constructor(message: string) {
    super('INVALID_CREATE_CONNECTOR_INPUT', message);
  }
}
