import { DomainError } from './domain-error';

/** Thrown by `revoke` when `credentialId` doesn't exist (or belongs to another tenant - RLS makes the two indistinguishable, which is correct). */
export class IngestionCredentialNotFoundError extends DomainError {
  readonly code = 'INGESTION_CREDENTIAL_NOT_FOUND';

  constructor(credentialId: string) {
    super(`No ingestion credential found with id ${credentialId}`);
  }
}
