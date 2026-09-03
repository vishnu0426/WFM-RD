import { DomainError } from './domain-error';

/** Thrown by `acknowledge`/`resolve` when `adherenceExceptionId` doesn't exist (or belongs to another tenant - RLS makes the two indistinguishable, which is correct). */
export class AdherenceExceptionNotFoundError extends DomainError {
  readonly code = 'ADHERENCE_EXCEPTION_NOT_FOUND';

  constructor(adherenceExceptionId: string) {
    super(`No adherence exception found with id ${adherenceExceptionId}`);
  }
}
