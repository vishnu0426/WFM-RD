import { DomainError } from '../../../common/errors/domain-error';

/** The pending-SSO-request Redis entry (`SsoLoginService`) was missing or expired when the callback arrived. */
export class SsoRequestExpiredError extends DomainError {
  readonly code = 'SSO_REQUEST_EXPIRED';

  constructor() {
    super('This SSO login attempt has expired or is invalid. Please restart the login flow.');
  }
}
