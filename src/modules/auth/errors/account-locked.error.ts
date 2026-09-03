import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** Too many failed password attempts (§5.7's failure-handling requirement). */
export class AccountLockedError extends OAuthDomainError {
  readonly code = 'OAUTH_ACCOUNT_LOCKED';
  readonly oauthError = 'invalid_grant';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(lockedUntil: Date) {
    super(`Account temporarily locked until ${lockedUntil.toISOString()} after repeated failed login attempts.`);
  }
}
