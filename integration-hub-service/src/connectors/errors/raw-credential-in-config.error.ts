import { DomainError } from '../../common/errors/domain-error';

export class RawCredentialInConfigError extends DomainError {
  constructor(fieldPath: string, reason: string) {
    super(
      'RAW_CREDENTIAL_IN_CONFIG',
      `Field "${fieldPath}" in IntegrationConnector.config looks like a raw credential (${reason}) - credentials must be written to Vault and referenced by key only.`,
    );
  }
}
