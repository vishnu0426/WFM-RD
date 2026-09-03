import { DomainError } from './domain-error';

/** Thrown by `approveReallocation` when `reallocationId` doesn't exist (or belongs to another tenant - RLS makes the two indistinguishable, which is correct). */
export class ReallocationNotFoundError extends DomainError {
  readonly code = 'REALLOCATION_NOT_FOUND';

  constructor(reallocationId: string) {
    super(`No reallocation action found with id ${reallocationId}`);
  }
}
