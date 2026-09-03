import { Injectable, Logger } from '@nestjs/common';
import { Issuer, type Client, errors as OpenIdErrors } from 'openid-client';
import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';
import { FederatedIdentity } from './saml.service';
import { SsoAssertionInvalidError } from '../errors/sso-assertion-invalid.error';
import { SsoProviderUnavailableError } from '../errors/sso-provider-unavailable.error';

const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h - discovery documents change rarely.

interface CachedClient {
  client: Client;
  cachedAt: number;
}

/**
 * §5.1's "generic OIDC" support for Entra ID/Okta/Auth0/Keycloak/Ping/
 * OneLogin/Google Workspace/GitHub Enterprise/GitLab/Apple - all speak
 * OIDC, so this is the one code path for all of them; per-vendor quirks
 * (e.g. Apple's JWT-based client secret rotation) are not implemented and
 * are flagged in the production readiness checklist as a per-vendor
 * follow-up if exact compliance with a specific vendor's non-standard
 * behavior is ever required.
 *
 * `openid-client` v5 (pinned - v6 is ESM-only and incompatible with this
 * repo's CommonJS build, see ADR-0030) is used only for the *external*
 * federation leg (this platform as an OIDC Relying Party to a tenant's
 * IdP) - completely separate from `jose`-based `TokenService`, which is
 * this platform acting as its *own* OIDC Provider (§5.6).
 */
@Injectable()
export class OidcFederationService {
  private readonly logger = new Logger(OidcFederationService.name);
  private readonly clientCache = new Map<string, CachedClient>();

  async buildAuthorizationUrl(
    provider: TenantIdentityProvider,
    callbackUrl: string,
    state: string,
    nonce: string,
  ): Promise<string> {
    const client = await this.getClient(provider, callbackUrl);
    return client.authorizationUrl({ scope: 'openid email profile', state, nonce });
  }

  async handleCallback(
    provider: TenantIdentityProvider,
    callbackUrl: string,
    code: string,
    state: string,
    nonce: string,
  ): Promise<FederatedIdentity> {
    const client = await this.getClient(provider, callbackUrl);
    let tokenSet;
    try {
      tokenSet = await client.callback(callbackUrl, { code, state }, { state, nonce });
    } catch (err) {
      if (err instanceof OpenIdErrors.OPError || err instanceof OpenIdErrors.RPError) {
        throw new SsoAssertionInvalidError(err.message);
      }
      throw new SsoProviderUnavailableError(provider.name, (err as Error).message);
    }

    const claims = tokenSet.claims();
    const mapping = provider.attributeMapping;
    const rawGroups = mapping.groups ? claims[mapping.groups] : claims.groups;

    return {
      subject: claims.sub,
      email: (mapping.email ? (claims[mapping.email] as string) : claims.email) ?? null,
      givenName: (mapping.givenName ? (claims[mapping.givenName] as string) : claims.given_name) ?? null,
      familyName: (mapping.familyName ? (claims[mapping.familyName] as string) : claims.family_name) ?? null,
      groups: normalizeGroups(rawGroups),
    };
  }

  /**
   * Frontend Phase 8 gap-fix (§2/§0.5): the "test connection" step before a
   * tenant can mark an OIDC provider active - a real `Issuer.discover(...)`
   * round-trip against `provider.oidcDiscoveryUrl`, the same discovery call
   * every real login attempt makes via `getClient`, just without
   * constructing a full `Client` (no `callbackUrl` exists yet at test time
   * in the general case) or ever touching this service's own discovery
   * cache - a test result should never be served stale.
   */
  async testDiscovery(provider: TenantIdentityProvider): Promise<{ success: boolean; message: string }> {
    try {
      await Issuer.discover(provider.oidcDiscoveryUrl!);
      return { success: true, message: 'OIDC discovery document fetched successfully.' };
    } catch (err) {
      return { success: false, message: `OIDC discovery failed: ${(err as Error).message}` };
    }
  }

  private async getClient(provider: TenantIdentityProvider, callbackUrl: string): Promise<Client> {
    const cacheKey = `${provider.id}:${callbackUrl}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < DISCOVERY_CACHE_TTL_MS) {
      return cached.client;
    }
    try {
      const issuer = await Issuer.discover(provider.oidcDiscoveryUrl!);
      const client = new issuer.Client({
        client_id: provider.oidcClientId!,
        client_secret: provider.oidcClientSecret!,
        redirect_uris: [callbackUrl],
        response_types: ['code'],
      });
      this.clientCache.set(cacheKey, { client, cachedAt: Date.now() });
      return client;
    } catch (err) {
      this.logger.warn(`OIDC discovery failed for provider=${provider.id}: ${(err as Error).message}`);
      throw new SsoProviderUnavailableError(provider.name, `discovery failed - ${(err as Error).message}`);
    }
  }
}

function normalizeGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}
