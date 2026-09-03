import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import { OAuthErrorFilter } from './oauth-error.filter';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuthorizeRequestDto } from '../dto/authorize-request.dto';
import { TokenRequestDto } from '../dto/token-request.dto';
import { RevokeRequestDto } from '../dto/revoke-request.dto';
import { IntrospectRequestDto } from '../dto/introspect-request.dto';
import { RegisterClientRequestDto } from '../dto/register-client-request.dto';
import { OAuthClientAuthService } from '../services/oauth-client-auth.service';
import { PasswordAuthService } from '../services/password-auth.service';
import { AuthorizationCodeService } from '../services/authorization-code.service';
import { PkceService } from '../services/pkce.service';
import { WebAuthnSessionService } from '../services/webauthn-session.service';
import { AuthMethodPolicyService } from '../services/auth-method-policy.service';
import { AccessRestrictionPolicyService } from '../services/access-restriction-policy.service';
import { TokenService, ACCESS_TOKEN_TTL_SECONDS } from '../services/token.service';
import { RefreshTokenService, REFRESH_TOKEN_TTL_DAYS } from '../services/refresh-token.service';
import { TokenRevocationService } from '../services/token-revocation.service';
import { UserContextCacheService } from '../services/user-context-cache.service';
import { OAuthClientsRepository } from '../repositories/oauth-clients.repository';
import { PasswordHasherService } from '../services/password-hasher.service';
import { OAuthClient } from '../entities/oauth-client.entity';
import { OAuthClientType } from '../entities/oauth-client-type.enum';
import { OAuthGrantType } from '../entities/oauth-grant-type.enum';
import { OAuthInvalidRequestError } from '../errors/invalid-request.error';
import { UnauthorizedClientError } from '../errors/unauthorized-client.error';
import { InvalidClientError } from '../errors/invalid-client.error';
import { AuditEventBatcherService } from '../../audit/services/audit-event-batcher.service';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { TenantSettingsRepository } from '../../tenant-settings/repositories/tenant-settings.repository';
import { randomUUID, randomBytes } from 'node:crypto';

interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
}

/**
 * §5's OAuth2.1/OIDC surface (Phase 2 scope: authorization_code+PKCE,
 * refresh_token rotation, client_credentials - device_authorization_code is
 * explicitly out of scope, see docs/phase-2-design-doc.md). Not `/v1/...`:
 * OAuth/OIDC endpoint paths are advertised via the discovery document
 * (`WellKnownController`), not versioned the same way this platform's own
 * REST API is.
 *
 * Every handler here throws `OAuthDomainError` subclasses, rendered by the
 * controller-scoped `OAuthErrorFilter` (not the global `DomainErrorFilter`)
 * into RFC 6749/7009/7662's `{error, error_description}` shape, since
 * generic OAuth client libraries parse that exact shape, not this
 * platform's `{error:{code,message,details}}` envelope (§3.4).
 *
 * Follow-up to Phase 5 (ADR-0044): token issuance/refresh/revocation and
 * client registration each record an `AuditEventBatcherService` entry -
 * fire-and-forget (not `AuditLogRepository.record` directly), matching
 * §3.3's batching semantics, since these are this module's highest-volume,
 * most latency-sensitive endpoints.
 */
@Controller('oauth')
@UseFilters(OAuthErrorFilter)
export class OAuthController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly clientAuth: OAuthClientAuthService,
    private readonly passwordAuth: PasswordAuthService,
    private readonly authorizationCodes: AuthorizationCodeService,
    private readonly pkce: PkceService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly userContextCache: UserContextCacheService,
    private readonly oauthClientsRepository: OAuthClientsRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly config: ConfigService,
    private readonly webauthnSessions: WebAuthnSessionService,
    private readonly authMethodPolicy: AuthMethodPolicyService,
    private readonly auditEvents: AuditEventBatcherService,
    private readonly tenantSettingsRepository: TenantSettingsRepository,
    private readonly accessRestrictionPolicy: AccessRestrictionPolicyService,
  ) {}

  /**
   * System Configuration's Session Management setting
   * (`TenantSettings.sessionTimeoutMinutes`) — real per-tenant access-token
   * TTL, not the fixed global `ACCESS_TOKEN_TTL_SECONDS` constant. Only for
   * real user logins (authorization_code/refresh_token grants); intentionally
   * NOT applied to client_credentials machine tokens. Must run inside the
   * already-bound `tenantContext.run({tenantId: client.tenantId}, ...)`
   * block every call site here already wraps its work in.
   */
  private async sessionTtlSeconds(): Promise<number> {
    const settings = await this.tenantSettingsRepository.getOrCreate();
    return settings.sessionTimeoutMinutes * 60;
  }

  /**
   * ADR-0026: combines resource-owner authentication with authorization-code
   * issuance in one API call, since this repo has no hosted login UI to
   * render a `GET /oauth/authorize` form against. A real deployment puts a
   * browser-rendered login page in front of this and treats this endpoint
   * as that page's form-submission target.
   *
   * Phase 3 (§5.4) adds a second credential shape: `webauthn_session_token`
   * (issued by `POST /webauthn/authenticate/verify`) in place of
   * `username`/`password`. Exactly one of the two must be present - checked
   * here at runtime (see `AuthorizeRequestDto`'s doc comment for why this
   * isn't expressed declaratively) - and `AuthMethodPolicyService` gates
   * whichever one was presented against the tenant's configured policy
   * before any credential is even checked.
   */
  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  async authorize(
    @Req() req: Request,
    @Body() dto: AuthorizeRequestDto,
  ): Promise<{ code: string; state: string | null }> {
    const client = await this.resolveActiveClient(dto.client_id);
    this.clientAuth.assertGrantTypeAllowed(client, OAuthGrantType.AUTHORIZATION_CODE);
    this.clientAuth.assertRedirectUriRegistered(client, dto.redirect_uri);
    this.pkce.assertSupportedMethod(dto.code_challenge_method);

    const usingWebAuthn = !!dto.webauthn_session_token;
    const usingPassword = !!dto.username || !!dto.password;
    if (usingWebAuthn === usingPassword) {
      throw new OAuthInvalidRequestError('Provide exactly one of (username and password) or webauthn_session_token.');
    }

    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      // System Configuration's Access Restrictions setting — checked before
      // either credential path, same "gate before any credential is even
      // checked" posture as AuthMethodPolicyService immediately below.
      await this.accessRestrictionPolicy.assertLoginPermitted({ ip: req.ip, email: dto.username ?? '' });

      const authTime = new Date();
      let userId: string;
      let amr: string[];

      if (usingWebAuthn) {
        await this.authMethodPolicy.assertMethodPermitted('webauthn');
        const session = await this.webauthnSessions.consume(dto.webauthn_session_token!);
        if (!session || session.tenantId !== client.tenantId) {
          throw new OAuthInvalidRequestError('webauthn_session_token is invalid, expired, or already used.');
        }
        userId = session.userId;
        amr = ['webauthn'];
      } else {
        await this.authMethodPolicy.assertMethodPermitted('pwd');
        if (!dto.username || !dto.password) {
          throw new OAuthInvalidRequestError('Both username and password are required.');
        }
        const user = await this.passwordAuth.authenticate(dto.username, dto.password);
        userId = user.id;
        amr = ['pwd'];
      }

      const code = await this.authorizationCodes.issue({
        tenantId: client.tenantId,
        clientId: client.id,
        userId,
        redirectUri: dto.redirect_uri,
        codeChallenge: dto.code_challenge,
        scope: dto.scope ?? '',
        nonce: dto.nonce ?? null,
        authTime,
        amr,
      });
      return { code, state: dto.state ?? null };
    });
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(
    @Body() dto: TokenRequestDto,
    @Headers('authorization') authorizationHeader?: string,
  ): Promise<Record<string, unknown>> {
    const creds = this.extractClientCredentials(dto, authorizationHeader);

    switch (dto.grant_type) {
      case OAuthGrantType.AUTHORIZATION_CODE:
        return this.handleAuthorizationCodeGrant(dto, creds);
      case OAuthGrantType.REFRESH_TOKEN:
        return this.handleRefreshTokenGrant(dto, creds);
      case OAuthGrantType.CLIENT_CREDENTIALS:
        return this.handleClientCredentialsGrant(dto, creds);
      default:
        throw new OAuthInvalidRequestError(`Unsupported grant_type: ${dto.grant_type as string}.`);
    }
  }

  /** RFC 7009 - always 200 unless client auth itself fails, so token scanning can't distinguish outcomes. */
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Body() dto: RevokeRequestDto,
    @Headers('authorization') authorizationHeader?: string,
  ): Promise<Record<string, never>> {
    const creds = this.extractClientCredentials(dto, authorizationHeader);
    if (!creds.clientId) {
      throw new OAuthInvalidRequestError('client_id is required.');
    }
    const client = await this.clientAuth.authenticate(creds.clientId, creds.clientSecret);

    await this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      if (dto.token_type_hint !== 'access_token') {
        await this.refreshTokens.revokeByRawToken(dto.token, 'client_requested_revocation');
      }
      try {
        const claims = await this.tokens.verifyAccessToken(dto.token);
        await this.tokenRevocation.revoke(claims.jti, new Date(claims.exp * 1000));
      } catch {
        // Not a valid/verifiable access token - fine, RFC 7009 §2.2 still returns 200.
      }
      this.auditEvents.enqueue({
        tenantId: client.tenantId,
        // `AuditLog.actor_id` is a strict `uuid` column (unlike the JWT
        // `sub` claim, which legitimately carries the `client:` prefix
        // elsewhere in this file/tenant-context.middleware.ts/
        // access-token.guard.ts/scim-auth.guard.ts) - a prefixed string
        // here fails every INSERT with a Postgres uuid-syntax error,
        // silently and permanently (AuditEventBatcherService retries
        // forever, since the row can never become valid). `actorType:
        // SYSTEM` already distinguishes this from a real user actor, so
        // the raw client id loses no information the prefix was adding.
        actorId: client.id,
        actorType: AuditActorType.SYSTEM,
        action: 'oauth_token.revoked',
        resourceType: 'oauth_client',
        resourceId: client.id,
        beforeState: null,
        afterState: { client_id: client.clientId, token_type_hint: dto.token_type_hint ?? null },
        aiRationale: null,
      });
    });
    return {};
  }

  /** RFC 7662 - always 200 with `active: false` for anything that doesn't validate, never an error. */
  @Post('introspect')
  @HttpCode(HttpStatus.OK)
  async introspect(
    @Body() dto: IntrospectRequestDto,
    @Headers('authorization') authorizationHeader?: string,
  ): Promise<Record<string, unknown>> {
    const creds = this.extractClientCredentials(dto, authorizationHeader);
    if (!creds.clientId) {
      throw new OAuthInvalidRequestError('client_id is required.');
    }
    const client = await this.clientAuth.authenticate(creds.clientId, creds.clientSecret);

    if (dto.token_type_hint !== 'refresh_token') {
      try {
        const claims = await this.tokens.verifyAccessToken(dto.token);
        const revoked = await this.tokenRevocation.isRevoked(claims.jti);
        if (!revoked) {
          return {
            active: true,
            sub: claims.sub,
            tenant_id: claims.tenant_id,
            scope: claims.permissions.join(' '),
            client_id: client.clientId,
            exp: claims.exp,
            iat: claims.iat,
            iss: claims.iss,
            aud: claims.aud,
          };
        }
      } catch {
        // Fall through to the refresh-token attempt below.
      }
    }

    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      const record = await this.refreshTokens.peekActive(dto.token, client.tenantId);
      if (!record) {
        return { active: false };
      }
      return {
        active: true,
        sub: record.userId,
        tenant_id: record.tenantId,
        scope: record.scope,
        client_id: client.clientId,
        exp: Math.floor(record.expiresAt.getTime() / 1000),
        iat: Math.floor(record.createdAt.getTime() / 1000),
        token_type: 'refresh_token',
      };
    });
  }

  /**
   * RFC 7591 §3.1, gated by a static bootstrap token (ADR-0026) - real
   * admin-permission gating needs Phase 4's RBAC enforcement.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterClientRequestDto,
    @Headers('x-registration-token') registrationToken: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<Record<string, unknown>> {
    const expected = this.config.get<string>('OAUTH_CLIENT_REGISTRATION_TOKEN');
    if (!expected || registrationToken !== expected) {
      throw new UnauthorizedException('Invalid or missing X-Registration-Token.');
    }
    if (!tenantIdHeader) {
      throw new OAuthInvalidRequestError('X-Tenant-Id header is required to register a client for a tenant.');
    }

    const isPublic = dto.token_endpoint_auth_method === 'none';
    const clientId = randomUUID();
    const plaintextSecret = isPublic ? null : randomBytes(24).toString('base64url');
    const clientSecretHash = plaintextSecret ? await this.passwordHasher.hash(plaintextSecret) : null;

    const created = await this.tenantContext.run({ tenantId: tenantIdHeader }, () =>
      this.oauthClientsRepository.create({
        tenantId: tenantIdHeader,
        clientId,
        clientSecretHash,
        clientType: isPublic ? OAuthClientType.PUBLIC : OAuthClientType.CONFIDENTIAL,
        name: dto.client_name,
        allowedGrantTypes: dto.grant_types,
        redirectUris: dto.redirect_uris,
        tokenEndpointAuthMethod: dto.token_endpoint_auth_method,
        isActive: true,
      }),
    );

    this.auditEvents.enqueue({
      tenantId: tenantIdHeader,
      actorId: null,
      actorType: AuditActorType.SYSTEM,
      action: 'oauth_client.registered',
      resourceType: 'oauth_client',
      resourceId: created.id,
      beforeState: null,
      afterState: {
        client_id: created.clientId,
        name: created.name,
        grant_types: created.allowedGrantTypes,
        client_type: created.clientType,
      },
      aiRationale: null,
    });

    return {
      client_id: created.clientId,
      // RFC 7591 §3.2.1: returned exactly once, at registration time - the
      // same posture §3.2 requires for webhook signing secrets. Never
      // retrievable again; only the hash is persisted.
      client_secret: plaintextSecret,
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      client_name: created.name,
      redirect_uris: created.redirectUris,
      grant_types: created.allowedGrantTypes,
      token_endpoint_auth_method: created.tokenEndpointAuthMethod,
    };
  }

  // -----------------------------------------------------------------------

  private async handleAuthorizationCodeGrant(
    dto: TokenRequestDto,
    creds: ClientCredentials,
  ): Promise<Record<string, unknown>> {
    if (!dto.code || !dto.redirect_uri || !dto.code_verifier || !creds.clientId) {
      throw new OAuthInvalidRequestError('code, redirect_uri, code_verifier, and client_id are required.');
    }
    const client = await this.clientAuth.authenticate(creds.clientId, creds.clientSecret);
    this.clientAuth.assertGrantTypeAllowed(client, OAuthGrantType.AUTHORIZATION_CODE);

    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      const record = await this.authorizationCodes.consume(dto.code!, client.id, dto.redirect_uri!);
      this.pkce.verify(dto.code_verifier!, record.codeChallenge);

      const userContext = await this.userContextCache.get(client.tenantId, record.userId);
      const ttlSeconds = await this.sessionTtlSeconds();
      const { token: accessToken } = await this.tokens.issueAccessToken({
        userId: record.userId,
        tenantId: client.tenantId,
        orgUnitId: userContext.orgUnitId,
        roles: userContext.roles,
        permissions: userContext.permissions,
        amr: record.amr,
        authTime: record.authTime,
        ttlSeconds,
      });
      const { rawToken: refreshToken } = await this.refreshTokens.issue({
        tenantId: client.tenantId,
        userId: record.userId,
        clientId: client.id,
        amr: record.amr,
        authTime: record.authTime,
        scope: record.scope,
      });

      const response: Record<string, unknown> = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ttlSeconds,
        refresh_token: refreshToken,
        scope: record.scope,
      };
      if (record.scope.split(' ').includes('openid')) {
        response.id_token = await this.tokens.issueIdToken({
          userId: record.userId,
          tenantId: client.tenantId,
          clientId: client.clientId,
          amr: record.amr,
          authTime: record.authTime,
          nonce: record.nonce,
        });
      }
      this.auditEvents.enqueue({
        tenantId: client.tenantId,
        actorId: record.userId,
        actorType: AuditActorType.USER,
        action: 'oauth_token.issued',
        resourceType: 'user',
        resourceId: record.userId,
        beforeState: null,
        afterState: {
          grant_type: 'authorization_code',
          client_id: client.clientId,
          scope: record.scope,
          amr: record.amr,
        },
        aiRationale: null,
      });
      return response;
    });
  }

  private async handleRefreshTokenGrant(
    dto: TokenRequestDto,
    creds: ClientCredentials,
  ): Promise<Record<string, unknown>> {
    if (!dto.refresh_token || !creds.clientId) {
      throw new OAuthInvalidRequestError('refresh_token and client_id are required.');
    }
    const client = await this.clientAuth.authenticate(creds.clientId, creds.clientSecret);
    this.clientAuth.assertGrantTypeAllowed(client, OAuthGrantType.REFRESH_TOKEN);

    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      const rotated = await this.refreshTokens.rotate(dto.refresh_token!);
      if (rotated.record.clientId !== client.id) {
        throw new UnauthorizedClientError('Refresh token was not issued to this client.');
      }
      const userContext = await this.userContextCache.get(client.tenantId, rotated.record.userId);
      const ttlSeconds = await this.sessionTtlSeconds();
      const { token: accessToken } = await this.tokens.issueAccessToken({
        userId: rotated.record.userId,
        tenantId: client.tenantId,
        orgUnitId: userContext.orgUnitId,
        roles: userContext.roles,
        permissions: userContext.permissions,
        amr: rotated.record.amr,
        authTime: rotated.record.authTime,
        ttlSeconds,
      });
      this.auditEvents.enqueue({
        tenantId: client.tenantId,
        actorId: rotated.record.userId,
        actorType: AuditActorType.USER,
        action: 'oauth_token.refreshed',
        resourceType: 'user',
        resourceId: rotated.record.userId,
        beforeState: null,
        afterState: { grant_type: 'refresh_token', client_id: client.clientId, scope: rotated.record.scope },
        aiRationale: null,
      });
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ttlSeconds,
        refresh_token: rotated.rawToken,
        refresh_token_expires_in: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
        scope: rotated.record.scope,
      };
    });
  }

  private async handleClientCredentialsGrant(
    dto: TokenRequestDto,
    creds: ClientCredentials,
  ): Promise<Record<string, unknown>> {
    if (!creds.clientId || !creds.clientSecret) {
      throw new InvalidClientError('client_credentials requires a confidential client.');
    }
    const client = await this.clientAuth.authenticate(creds.clientId, creds.clientSecret);
    if (client.clientType !== OAuthClientType.CONFIDENTIAL) {
      throw new UnauthorizedClientError('Public clients may not use the client_credentials grant.');
    }
    this.clientAuth.assertGrantTypeAllowed(client, OAuthGrantType.CLIENT_CREDENTIALS);

    return this.tenantContext.run({ tenantId: client.tenantId }, async () => {
      // Machine token: `sub` identifies the client, not a user - no roles/
      // permissions/org_unit_id (§2.1's ABAC model is user-role-based; a
      // client-level permission grant is not in scope for Phase 2 - see
      // docs/phase-2-design-doc.md).
      const { token: accessToken } = await this.tokens.issueAccessToken({
        userId: `client:${client.id}`,
        tenantId: client.tenantId,
        orgUnitId: null,
        roles: [],
        permissions: [],
        amr: ['client_credentials'],
        authTime: new Date(),
      });
      this.auditEvents.enqueue({
        tenantId: client.tenantId,
        // See the `oauth_token.revoked` audit call above for why this is
        // the raw client id, not the `client:`-prefixed JWT-sub form.
        actorId: client.id,
        actorType: AuditActorType.SYSTEM,
        action: 'oauth_token.issued',
        resourceType: 'oauth_client',
        resourceId: client.id,
        beforeState: null,
        afterState: { grant_type: 'client_credentials', client_id: client.clientId, scope: dto.scope ?? '' },
        aiRationale: null,
      });
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: dto.scope ?? '',
      };
    });
  }

  private async resolveActiveClient(clientId: string): Promise<OAuthClient> {
    const client = await this.oauthClientsRepository.findByClientId(clientId);
    if (!client || !client.isActive) {
      throw new InvalidClientError();
    }
    return client;
  }

  private extractClientCredentials(
    dto: { client_id?: string; client_secret?: string },
    authorizationHeader?: string,
  ): ClientCredentials {
    if (authorizationHeader?.startsWith('Basic ')) {
      const decoded = Buffer.from(authorizationHeader.slice('Basic '.length), 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');
      if (separatorIndex === -1) {
        throw new OAuthInvalidRequestError('Malformed Basic authorization header.');
      }
      return {
        clientId: decodeURIComponent(decoded.slice(0, separatorIndex)),
        clientSecret: decodeURIComponent(decoded.slice(separatorIndex + 1)),
      };
    }
    return { clientId: dto.client_id ?? '', clientSecret: dto.client_secret ?? null };
  }
}
