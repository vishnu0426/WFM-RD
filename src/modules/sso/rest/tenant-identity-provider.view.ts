import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';

/**
 * `TenantIdentityProvider.oidcClientSecret` is a real plaintext credential
 * (unlike `OAuthClient.clientSecretHash`, which is safely a hash - see that
 * entity's own doc comment) needed in full to present back to the external
 * IdP during token exchange, so it can never be returned from any API
 * response. `samlCertificate` is the IdP's public signing certificate, not a
 * secret, and is returned as-is.
 */
export type TenantIdentityProviderView = Omit<TenantIdentityProvider, 'oidcClientSecret' | 'validateProtocolFields'> & {
  oidcClientSecretSet: boolean;
};

export function toIdentityProviderView(provider: TenantIdentityProvider): TenantIdentityProviderView {
  const { oidcClientSecret, ...rest } = provider;
  return { ...rest, oidcClientSecretSet: !!oidcClientSecret };
}
