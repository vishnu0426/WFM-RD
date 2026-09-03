import { DomainError } from '../../../common/errors/domain-error';

/** A password that doesn't meet the caller's tenant's configured `TenantSettings` security policy. */
export class WeakPasswordError extends DomainError {
  readonly code = 'WEAK_PASSWORD';

  constructor(unmetRules: string[]) {
    super(`Password does not meet this tenant's security policy: ${unmetRules.join('; ')}.`, { unmetRules });
  }
}
