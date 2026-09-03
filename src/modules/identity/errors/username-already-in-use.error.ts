import { DomainError } from '../../../common/errors/domain-error';

/** `PATCH /v1/users/:id/username` refuses to set a username another user in this tenant already holds (case-insensitively, per `UsersRepository.findByUsername`/`uq_users_tenant_id_username_lower`) - same "already in use" posture as `EmailAlreadyInUseError`. */
export class UsernameAlreadyInUseError extends DomainError {
  readonly code = 'USERNAME_ALREADY_IN_USE';

  constructor(username: string) {
    super(`Username ${username} is already in use for this tenant.`, { username });
  }
}
