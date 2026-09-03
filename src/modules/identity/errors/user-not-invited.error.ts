import { DomainError } from '../../../common/errors/domain-error';

/** `POST /v1/users/:id/resend-invite` only makes sense for a user still sitting in `UserStatus.INVITED` - an already-active (or disabled) user has no pending invite to resend, and issuing one anyway would silently let an admin re-arm `POST /v1/auth/accept-invite` for an account that's already past that step. Conflict, not not-found: the user id is real, its current state just isn't eligible. */
export class UserNotInvitedError extends DomainError {
  readonly code = 'USER_NOT_INVITED';

  constructor(id: string) {
    super(`User ${id} is not in the invited state.`, { id });
  }
}
