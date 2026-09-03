import { DomainError } from '../../../common/errors/domain-error';

export class WebAuthnChallengeExpiredError extends DomainError {
  readonly code = 'WEBAUTHN_CHALLENGE_EXPIRED';

  constructor() {
    super('This WebAuthn ceremony has expired or is invalid. Please restart it.');
  }
}
