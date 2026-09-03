import { DomainError } from '../../../common/errors/domain-error';

/**
 * Thrown when `updateEmployee(userId)` would violate the new
 * `uq_employees_tenant_id_user_id` partial unique index - the requested
 * `userId` is already linked to a different `Employee` in this tenant
 * (ADR-0150's gap: the reverse-lookup index guarantees at most one
 * employee per user, so a second link attempt is a real conflict, not a
 * race to paper over).
 */
export class UserAlreadyLinkedError extends DomainError {
  readonly code = 'USER_ALREADY_LINKED';

  constructor(userId: string) {
    super(`User ${userId} is already linked to a different employee.`, { userId });
  }
}
