import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** RFC 6749 §5.2 `invalid_scope`. */
export class InvalidScopeError extends OAuthDomainError {
  readonly code = 'OAUTH_INVALID_SCOPE';
  readonly oauthError = 'invalid_scope';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(message: string) {
    super(message);
  }
}
