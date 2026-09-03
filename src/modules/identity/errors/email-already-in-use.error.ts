import { DomainError } from '../../../common/errors/domain-error';

/** Frontend Phase 8 gap-fix: `POST /v1/users/invite` refuses to create a second `User` row for an email already on file for this tenant, active or still-pending - re-inviting an already-invited address is a deliberate, disclosed scope cut (see `UserManagementController`'s own doc comment), not an oversight. */
export class EmailAlreadyInUseError extends DomainError {
  readonly code = 'EMAIL_ALREADY_IN_USE';

  constructor(email: string) {
    super(`A user with email ${email} already exists for this tenant.`, { email });
  }
}
