import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantIdentityProvidersRepository } from '../repositories/tenant-identity-providers.repository';
import { OAuthClientsRepository } from '../../auth/repositories/oauth-clients.repository';
import { OAuthClientAuthService } from '../../auth/services/oauth-client-auth.service';
import { PkceService } from '../../auth/services/pkce.service';
import { AuthorizationCodeService } from '../../auth/services/authorization-code.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { UserStatus } from '../../identity/entities/user-status.enum';
import { User } from '../../identity/entities/user.entity';
import { SsoLoginService, PendingSsoRequest } from '../services/sso-login.service';
import { SsoLoginQueryDto } from '../dto/sso-login-query.dto';
import { SamlService, FederatedIdentity } from '../services/saml.service';
import { OidcFederationService } from '../services/oidc-federation.service';
import { TenantIdentityProvider } from '../entities/tenant-identity-provider.entity';
import { IdentityProviderProtocol } from '../entities/identity-provider-protocol.enum';
import { IdentityProviderNotFoundError } from '../errors/identity-provider-not-found.error';
import { SsoRequestExpiredError } from '../errors/sso-request-expired.error';
import { SsoAssertionInvalidError } from '../errors/sso-assertion-invalid.error';
import { OAuthGrantType } from '../../auth/entities/oauth-grant-type.enum';
import { InvalidClientError } from '../../auth/errors/invalid-client.error';
import { AuditEventBatcherService } from '../../audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §3.2's `POST /v1/auth/sso/callback` - "shared SAML + OIDC callback
 * handler - dispatch by configured protocol per tenant IdP config" - plus
 * the login-initiation endpoint §3.2 doesn't name but is obviously required
 * (§5.7's error-handling requirements presuppose a request that can fail).
 *
 * Both protocols' browser-driven redirects land on the *same route path*
 * (`/v1/auth/sso/callback`) but arrive via different HTTP methods by
 * nature - SAML's HTTP-POST binding auto-submits a form (`POST`), OIDC's
 * authorization response is a redirect with query params (`GET`). Both
 * handlers below delegate to the same private `dispatchCallback` - "shared
 * handler" means shared logic, not literally one HTTP method serving both
 * browser mechanics (see docs/phase-3-design-doc.md's explicit assumptions).
 *
 * Every handler that has already resolved a `PendingSsoRequest` (and
 * therefore knows the *original* client's `redirect_uri`) redirects failures
 * back to that client with an OAuth-style `?error=...` query string, the way
 * a real IdP would - not a JSON error body, since this is a browser
 * navigation, not an API call the client's own code is inspecting
 * synchronously.
 */
@Controller('v1/auth/sso')
export class SsoController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly identityProviders: TenantIdentityProvidersRepository,
    private readonly oauthClientsRepository: OAuthClientsRepository,
    private readonly clientAuth: OAuthClientAuthService,
    private readonly pkce: PkceService,
    private readonly ssoLogin: SsoLoginService,
    private readonly samlService: SamlService,
    private readonly oidcFederation: OidcFederationService,
    private readonly usersRepository: UsersRepository,
    private readonly authorizationCodes: AuthorizationCodeService,
    private readonly config: ConfigService,
    private readonly auditEvents: AuditEventBatcherService,
  ) {}

  @Get('login/:tenantIdpId')
  async login(
    @Param('tenantIdpId') tenantIdpId: string,
    @Query() query: SsoLoginQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const provider = await this.identityProviders.findById(tenantIdpId);
    if (!provider || !provider.isActive) {
      throw new IdentityProviderNotFoundError(tenantIdpId);
    }

    await this.tenantContext.run({ tenantId: provider.tenantId }, async () => {
      const client = await this.resolveActiveClient(query.client_id);
      this.clientAuth.assertGrantTypeAllowed(client, OAuthGrantType.AUTHORIZATION_CODE);
      this.clientAuth.assertRedirectUriRegistered(client, query.redirect_uri);
      this.pkce.assertSupportedMethod(query.code_challenge_method);

      const requestId = await this.ssoLogin.createPendingRequest({
        tenantId: provider.tenantId,
        providerId: provider.id,
        clientId: client.id,
        redirectUri: query.redirect_uri,
        codeChallenge: query.code_challenge,
        scope: query.scope ?? '',
        originalState: query.state ?? null,
        nonce: query.nonce ?? null,
      });

      const callbackUrl = this.callbackUrl();
      const redirectUrl =
        provider.protocol === IdentityProviderProtocol.SAML
          ? await this.samlService.buildAuthnRequestUrl(provider, callbackUrl, requestId)
          : await this.oidcFederation.buildAuthorizationUrl(provider, callbackUrl, requestId, query.nonce ?? requestId);

      res.redirect(302, redirectUrl);
    });
  }

  /** Lets a tenant admin import this SP's SAML metadata directly into their IdP's connector config. */
  @Get(':tenantIdpId/metadata')
  async metadata(@Param('tenantIdpId') tenantIdpId: string, @Res() res: Response): Promise<void> {
    const provider = await this.identityProviders.findById(tenantIdpId);
    if (!provider || provider.protocol !== IdentityProviderProtocol.SAML) {
      throw new IdentityProviderNotFoundError(tenantIdpId);
    }
    const xml = this.samlService.generateMetadata(provider, this.callbackUrl());
    res.set('Content-Type', 'application/xml').send(xml);
  }

  /** OIDC's authorization response - a redirect with query params, hence `GET` (see class doc comment). */
  @Get('callback')
  async oidcCallback(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    const requestId = query.state;
    if (query.error) {
      await this.dispatchFailure(requestId, new SsoAssertionInvalidError(query.error_description ?? query.error), res);
      return;
    }
    await this.dispatchCallback(
      requestId,
      (provider, callbackUrl, pending) =>
        this.oidcFederation.handleCallback(provider, callbackUrl, query.code, requestId, pending.nonce ?? requestId),
      res,
    );
  }

  /** SAML 2.0's HTTP-POST binding ACS endpoint - an auto-submitting form, hence `POST` (see class doc comment). */
  @Post('callback')
  async samlCallback(@Body() body: { SAMLResponse: string; RelayState?: string }, @Res() res: Response): Promise<void> {
    await this.dispatchCallback(
      body.RelayState,
      (provider, callbackUrl) =>
        this.samlService.validateResponse(provider, callbackUrl, body.SAMLResponse, body.RelayState),
      res,
    );
  }

  // -----------------------------------------------------------------------

  private callbackUrl(): string {
    return `${this.config.get<string>('OIDC_ISSUER', 'https://auth.agno-wfm.local')}/v1/auth/sso/callback`;
  }

  private async resolveActiveClient(clientId: string) {
    const client = await this.oauthClientsRepository.findByClientId(clientId);
    if (!client || !client.isActive) {
      throw new InvalidClientError();
    }
    return client;
  }

  private async dispatchCallback(
    requestId: string | undefined,
    federate: (
      provider: TenantIdentityProvider,
      callbackUrl: string,
      pending: PendingSsoRequest,
    ) => Promise<FederatedIdentity>,
    res: Response,
  ): Promise<void> {
    if (!requestId) {
      throw new SsoRequestExpiredError();
    }
    const pending = await this.ssoLogin.consumePendingRequest(requestId);
    if (!pending) {
      throw new SsoRequestExpiredError();
    }

    await this.tenantContext.run({ tenantId: pending.tenantId }, async () => {
      const provider = await this.identityProviders.findByTenantAndId(pending.providerId);
      if (!provider) {
        throw new IdentityProviderNotFoundError(pending.providerId);
      }

      let identity: FederatedIdentity;
      try {
        identity = await federate(provider, this.callbackUrl(), pending);
        if (!identity.email) {
          throw new SsoAssertionInvalidError('identity provider did not return an email attribute');
        }
      } catch (err) {
        if (err instanceof DomainError) {
          this.redirectWithError(res, pending, err);
          return;
        }
        throw err;
      }

      const { user, provisioned } = await this.findOrProvisionUser(pending.tenantId, identity);
      const amr = [provider.protocol === IdentityProviderProtocol.SAML ? 'saml' : 'oidc'];
      const code = await this.authorizationCodes.issue({
        tenantId: pending.tenantId,
        clientId: pending.clientId,
        userId: user.id,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scope: pending.scope,
        nonce: pending.nonce,
        authTime: new Date(),
        amr,
      });
      this.auditEvents.enqueue({
        tenantId: pending.tenantId,
        actorId: user.id,
        actorType: AuditActorType.USER,
        action: 'sso_login.succeeded',
        resourceType: 'user',
        resourceId: user.id,
        beforeState: null,
        afterState: { tenant_identity_provider_id: provider.id, protocol: provider.protocol, provisioned },
        aiRationale: null,
      });

      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (pending.originalState) {
        redirectUrl.searchParams.set('state', pending.originalState);
      }
      res.redirect(302, redirectUrl.toString());
    });
  }

  private async dispatchFailure(requestId: string | undefined, error: DomainError, res: Response): Promise<void> {
    if (!requestId) {
      throw error;
    }
    const pending = await this.ssoLogin.consumePendingRequest(requestId);
    if (!pending) {
      throw error;
    }
    this.redirectWithError(res, pending, error);
  }

  private redirectWithError(res: Response, pending: PendingSsoRequest, error: DomainError): void {
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('error', 'access_denied');
    redirectUrl.searchParams.set('error_description', error.message);
    if (pending.originalState) {
      redirectUrl.searchParams.set('state', pending.originalState);
    }
    res.redirect(302, redirectUrl.toString());
  }

  /**
   * JIT provisioning (§5.7's implicit requirement - an IdP-federated user
   * shouldn't need a separate manual provisioning step before their first
   * login, absent SCIM having already created them). Match order: existing
   * `external_idp_id` link, then email within the tenant (and link it), then
   * create new.
   */
  private async findOrProvisionUser(
    tenantId: string,
    identity: FederatedIdentity,
  ): Promise<{ user: User; provisioned: boolean }> {
    const byExternalId = await this.usersRepository.find({ where: { externalIdpId: identity.subject } as never });
    if (byExternalId.length > 0) {
      return { user: byExternalId[0], provisioned: false };
    }
    const byEmail = await this.usersRepository.findByEmail(identity.email!);
    if (byEmail) {
      await this.usersRepository.update({ id: byEmail.id } as never, { externalIdpId: identity.subject } as never);
      return { user: byEmail, provisioned: false };
    }
    const user = await this.usersRepository.save({
      tenantId,
      externalIdpId: identity.subject,
      email: identity.email!,
      status: UserStatus.ACTIVE,
      mfaEnabled: false,
    } as never);
    return { user, provisioned: true };
  }
}
