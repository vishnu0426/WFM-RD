import { DomainError } from '../common/errors/domain-error';

/** §0.5's chaos-test posture (`integration-hub-service`'s own convention): every `VaultClientService` method throws one of these two on any failure - there is no catch-and-return-null path anywhere in this client, by design. A credential lookup failing closed beats it silently falling back to nothing. */
export class VaultUnavailableError extends DomainError {
  readonly code = 'VAULT_UNAVAILABLE';

  constructor(operation: string, cause: string) {
    super(`Vault ${operation} failed: ${cause}`);
  }
}

export class VaultSecretNotFoundError extends DomainError {
  readonly code = 'VAULT_SECRET_NOT_FOUND';

  constructor(path: string) {
    super(`No secret found at Vault path "${path}".`);
  }
}
