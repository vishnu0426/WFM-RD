import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** RFC 6749 §5.2 `invalid_client` - unknown client_id, bad secret, or inactive client. */
export class InvalidClientError extends OAuthDomainError {
  readonly code = 'OAUTH_INVALID_CLIENT';
  readonly oauthError = 'invalid_client';
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor(message = 'Client authentication failed.') {
    super(message);
  }
}
