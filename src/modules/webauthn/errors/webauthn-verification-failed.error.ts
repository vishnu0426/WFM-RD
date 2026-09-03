import { DomainError } from '../../../common/errors/domain-error';

export class WebAuthnVerificationFailedError extends DomainError {
  readonly code = 'WEBAUTHN_VERIFICATION_FAILED';

  constructor(reason: string) {
    super(`WebAuthn ceremony could not be verified: ${reason}`);
  }
}
