import { DomainError } from '../../../common/errors/domain-error';

/**
 * §5.7: "what happens ... on a SAML assertion with an expired certificate."
 * Covers SAML signature/certificate validation failures and OIDC id_token
 * verification failures alike - both are "the IdP's response could not be
 * cryptographically trusted," handled identically by the callback dispatcher.
 */
export class SsoAssertionInvalidError extends DomainError {
  readonly code = 'SSO_ASSERTION_INVALID';

  constructor(reason: string) {
    super(`Identity provider response could not be validated: ${reason}`);
  }
}
