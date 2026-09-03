import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** RFC 6749 §5.2 `unauthorized_client` - client is not allowed to use the requested grant type. */
export class UnauthorizedClientError extends OAuthDomainError {
  readonly code = 'OAUTH_UNAUTHORIZED_CLIENT';
  readonly oauthError = 'unauthorized_client';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(message: string) {
    super(message);
  }
}
