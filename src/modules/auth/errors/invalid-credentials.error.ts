import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/**
 * Resource-owner username/password mismatch at `POST /oauth/authorize`
 * (ADR-0026's API-first simplification). Modeled as RFC 6749's
 * `invalid_grant` - there is no dedicated OAuth error code for "bad
 * password," and `invalid_grant` is the closest standard fit (the same code
 * the deprecated Resource Owner Password Credentials grant used for this
 * exact failure).
 */
export class InvalidCredentialsError extends OAuthDomainError {
  readonly code = 'OAUTH_INVALID_CREDENTIALS';
  readonly oauthError = 'invalid_grant';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor() {
    super('Incorrect username or password.');
  }
}
