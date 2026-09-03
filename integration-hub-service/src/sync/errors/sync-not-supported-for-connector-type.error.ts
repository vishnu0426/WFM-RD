import { DomainError } from '../../common/errors/domain-error';

export class SyncNotSupportedForConnectorTypeError extends DomainError {
  constructor(connectorType: string) {
    super(
      'SYNC_NOT_SUPPORTED_FOR_CONNECTOR_TYPE',
      `connector_type "${connectorType}" is not a batch connector - streaming (acd) connectors don't have a discrete "sync" to trigger; use the relay start/stop/status endpoints instead (§3.2).`,
    );
  }
}
