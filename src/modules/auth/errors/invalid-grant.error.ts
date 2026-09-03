import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/**
 * RFC 6749 §5.2 `invalid_grant` - expired/consumed authorization code, bad
 * PKCE verifier, expired/revoked refresh token, or bad resource-owner
 * credentials at `/oauth/authorize`.
 */
export class InvalidGrantError extends OAuthDomainError {
  readonly code = 'OAUTH_INVALID_GRANT';
  readonly oauthError = 'invalid_grant';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(message: string) {
    super(message);
  }
}
