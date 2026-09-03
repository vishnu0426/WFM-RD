import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** RFC 6749 §5.2 `invalid_request` - malformed or missing required parameter. */
export class OAuthInvalidRequestError extends OAuthDomainError {
  readonly code = 'OAUTH_INVALID_REQUEST';
  readonly oauthError = 'invalid_request';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(message: string) {
    super(message);
  }
}
