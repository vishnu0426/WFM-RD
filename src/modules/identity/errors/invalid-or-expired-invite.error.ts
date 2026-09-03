import { DomainError } from '../../../common/errors/domain-error';

/** Frontend Phase 8 gap-fix: covers all three `accept-invite` failure modes (unknown token, expired, already accepted) with one deliberately non-distinguishing message - same "don't leak which specific thing was wrong about a pre-auth credential" posture `InvalidCredentialsError` already takes. */
export class InvalidOrExpiredInviteError extends DomainError {
  readonly code = 'INVALID_OR_EXPIRED_INVITE';

  constructor() {
    super('This invite link is invalid, expired, or has already been used.');
  }
}
