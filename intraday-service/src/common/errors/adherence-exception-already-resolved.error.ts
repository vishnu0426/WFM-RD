import { DomainError } from './domain-error';

/** Thrown by `acknowledge`/`resolve` when the row is already `resolved` - a terminal status, not something a second acknowledge/resolve call should silently overwrite. */
export class AdherenceExceptionAlreadyResolvedError extends DomainError {
  readonly code = 'ADHERENCE_EXCEPTION_ALREADY_RESOLVED';

  constructor(adherenceExceptionId: string) {
    super(`Adherence exception ${adherenceExceptionId} is already resolved`);
  }
}
