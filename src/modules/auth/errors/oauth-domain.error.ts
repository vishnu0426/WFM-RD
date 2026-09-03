import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';

/**
 * OAuth/OIDC endpoints (`/oauth/*`, `/.well-known/*`) are a standards-
 * compliant protocol surface consumed by generic OAuth client libraries,
 * which parse RFC 6749/6750/7662's `{error, error_description}` shape, not
 * this platform's own `{error:{code,message,details}}` envelope (§3.4). Every
 * error this module throws in that surface extends this class so
 * `OAuthController` can render the RFC-correct body directly, while `code`
 * still feeds the same canonical error-code registry (§3.4) every other
 * DomainError in this repo uses for logging/observability/audit consistency.
 */
export abstract class OAuthDomainError extends DomainError {
  abstract readonly oauthError: string;
  abstract readonly httpStatus: HttpStatus;
}
