import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SAML } from '@node-saml/node-saml';
import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';
import { SsoAssertionInvalidError } from '../errors/sso-assertion-invalid.error';

export interface FederatedIdentity {
  subject: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  groups: string[];
}

/**
 * §5.1's SAML 2.0 SP support, via `@node-saml/node-saml` - a per-request
 * `SAML` client is constructed from the resolved `TenantIdentityProvider`
 * row (there is no single "the SAML config," every tenant's IdP is
 * different), never a shared/global instance.
 */
@Injectable()
export class SamlService {
  private readonly issuer: string;

  constructor(config: ConfigService) {
    this.issuer = config.get<string>('OIDC_ISSUER', 'https://auth.agno-wfm.local');
  }

  private buildClient(provider: TenantIdentityProvider, callbackUrl: string): SAML {
    return new SAML({
      idpCert: provider.samlCertificate!,
      // SP entity id is scoped per-provider so the same platform issuer
      // string doesn't collide across tenants' independently-configured IdPs.
      issuer: `${this.issuer}/sso/${provider.id}`,
      callbackUrl,
      entryPoint: provider.samlSsoUrl!,
      logoutUrl: provider.samlSloUrl ?? undefined,
      wantAssertionsSigned: true,
    });
  }

  async buildAuthnRequestUrl(
    provider: TenantIdentityProvider,
    callbackUrl: string,
    relayState: string,
  ): Promise<string> {
    const client = this.buildClient(provider, callbackUrl);
    try {
      return await client.getAuthorizeUrlAsync(relayState, undefined, {});
    } catch (err) {
      throw new SsoAssertionInvalidError(`could not build SAML AuthnRequest: ${(err as Error).message}`);
    }
  }

  /**
   * §5.7: "what happens on a SAML assertion with an expired certificate" -
   * `@node-saml/node-saml` throws on signature/timestamp/audience validation
   * failure; every failure mode is caught and normalized into
   * `SsoAssertionInvalidError` here rather than leaking an XML-parsing
   * library's raw error type up to the controller.
   */
  async validateResponse(
    provider: TenantIdentityProvider,
    callbackUrl: string,
    samlResponseBody: string,
    relayState: string | undefined,
  ): Promise<FederatedIdentity> {
    const client = this.buildClient(provider, callbackUrl);
    let profile;
    try {
      const result = await client.validatePostResponseAsync({
        SAMLResponse: samlResponseBody,
        ...(relayState ? { RelayState: relayState } : {}),
      });
      profile = result.profile;
    } catch (err) {
      throw new SsoAssertionInvalidError((err as Error).message);
    }
    if (!profile) {
      throw new SsoAssertionInvalidError('SAML response contained no assertion profile.');
    }

    const mapping = provider.attributeMapping;
    const emailAttr = mapping.email ?? 'email';
    const givenNameAttr = mapping.givenName ?? 'givenName';
    const familyNameAttr = mapping.familyName ?? 'familyName';
    const groupsAttr = mapping.groups ?? 'groups';

    return {
      subject: profile.nameID,
      email: (profile.email ?? profile.mail ?? profile[emailAttr]) as string | null,
      givenName: (profile[givenNameAttr] as string | undefined) ?? null,
      familyName: (profile[familyNameAttr] as string | undefined) ?? null,
      groups: normalizeGroups(profile[groupsAttr]),
    };
  }

  /** SP metadata XML - lets a tenant admin import this directly into their IdP's connector config. */
  generateMetadata(provider: TenantIdentityProvider, callbackUrl: string): string {
    const client = this.buildClient(provider, callbackUrl);
    return client.generateServiceProviderMetadata(null, null);
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
