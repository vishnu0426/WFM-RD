import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/**
 * ADR-0025: a refresh token outside the current generation of its family was
 * presented - almost certainly token theft (an attacker replayed a stolen,
 * already-rotated token). The caller (`RefreshTokenService`) has already
 * revoked the entire family by the time this is thrown; this error only
 * carries the RFC 6749 `invalid_grant` response back to whichever caller
 * (legitimate or attacker) sent the reused token; the response is
 * intentionally identical to any other invalid_grant so an attacker cannot
 * distinguish "reuse detected" from "token merely expired."
 */
export class RefreshTokenReusedError extends OAuthDomainError {
  readonly code = 'OAUTH_REFRESH_TOKEN_REUSE_DETECTED';
  readonly oauthError = 'invalid_grant';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor() {
    super('Refresh token is invalid.');
  }
}
