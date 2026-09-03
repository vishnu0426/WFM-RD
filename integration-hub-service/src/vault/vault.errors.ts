import { DomainError } from '../common/errors/domain-error';

/**
 * §0.5's chaos-test posture: "kill the connection to Vault mid-sync and
 * verify the sync job fails closed... rather than falling back to any
 * cached or default credential." Every `VaultClientService` method throws
 * one of these two on any failure - there is no catch-and-return-null path
 * anywhere in this client, by design.
 */
export class VaultUnavailableError extends DomainError {
  constructor(operation: string, cause: string) {
    super('VAULT_UNAVAILABLE', `Vault ${operation} failed: ${cause}`);
  }
}

export class VaultSecretNotFoundError extends DomainError {
  constructor(path: string) {
    super('VAULT_SECRET_NOT_FOUND', `No secret found at Vault path "${path}".`);
  }
}
