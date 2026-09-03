import { DomainError } from '../../common/errors/domain-error';

export class RelayNotSupportedForConnectorTypeError extends DomainError {
  constructor(connectorType: string) {
    super(
      'RELAY_NOT_SUPPORTED_FOR_CONNECTOR_TYPE',
      `connector_type "${connectorType}" is not a streaming (acd) connector - the relay start/stop/status endpoints only apply to acd connectors (§3.2).`,
    );
  }
}
