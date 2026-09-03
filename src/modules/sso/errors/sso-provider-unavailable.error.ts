import { DomainError } from '../../../common/errors/domain-error';

/** §5.7: "what happens on IdP downtime" - the discovery endpoint or token endpoint couldn't be reached. */
export class SsoProviderUnavailableError extends DomainError {
  readonly code = 'SSO_PROVIDER_UNAVAILABLE';

  constructor(providerName: string, cause: string) {
    super(`Identity provider "${providerName}" is currently unavailable: ${cause}`);
  }
}
