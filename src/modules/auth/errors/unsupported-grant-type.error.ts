import { HttpStatus } from '@nestjs/common';
import { OAuthDomainError } from './oauth-domain.error';

/** RFC 6749 §5.2 `unsupported_grant_type`. */
export class UnsupportedGrantTypeError extends OAuthDomainError {
  readonly code = 'OAUTH_UNSUPPORTED_GRANT_TYPE';
  readonly oauthError = 'unsupported_grant_type';
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(grantType: string) {
    super(`Unsupported grant_type: ${grantType}.`);
  }
}
