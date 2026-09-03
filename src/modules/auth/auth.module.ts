import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OAuthClient } from './entities/oauth-client.entity';
import { UserCredential } from './entities/user-credential.entity';
import { SigningKey } from './entities/signing-key.entity';
import { AuthorizationCode } from './entities/authorization-code.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { OAuthClientsRepository } from './repositories/oauth-clients.repository';
import { UserCredentialsRepository } from './repositories/user-credentials.repository';
import { SigningKeysRepository } from './repositories/signing-keys.repository';
import { AuthorizationCodesRepository } from './repositories/authorization-codes.repository';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';
import { PasswordHasherService } from './services/password-hasher.service';
import { SigningKeyService } from './services/signing-key.service';
import { PkceService } from './services/pkce.service';
import { TokenService } from './services/token.service';
import { TokenRevocationService } from './services/token-revocation.service';
import { RefreshTokenService } from './services/refresh-token.service';
import { UserContextCacheService } from './services/user-context-cache.service';
import { OAuthClientAuthService } from './services/oauth-client-auth.service';
import { PasswordAuthService } from './services/password-auth.service';
import { AuthorizationCodeService } from './services/authorization-code.service';
import { WebAuthnSessionService } from './services/webauthn-session.service';
import { AuthMethodPolicyService } from './services/auth-method-policy.service';
import { AccessRestrictionPolicyService } from './services/access-restriction-policy.service';
import { OAuthController } from './rest/oauth.controller';
import { WellKnownController } from './rest/well-known.controller';
import { AccessTokenGuard } from './rest/access-token.guard';
import { PermissionsGuard } from './rest/permissions.guard';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { AuditModule } from '../audit/audit.module';
import { TenantSettingsModule } from '../tenant-settings/tenant-settings.module';

/**
 * Module 01 Phase 2 (§8): OAuth2.1/OIDC/PKCE, JWT issuance + rotation,
 * Redis-backed session/UserContext caching, and the data layer
 * `IdentityGrpcController` (src/grpc) builds on. See docs/phase-2-design-doc.md.
 *
 * Phase 3 additions: `WebAuthnSessionService` (the bridge `WebAuthnModule`
 * writes into and `OAuthController.authorize` reads from - see that
 * service's own doc comment for why it lives here, not in `WebAuthnModule`)
 * and `AuthMethodPolicyService` (§5.4's per-tenant required/optional auth
 * method policy, hence the `PolicyModule` import).
 *
 * Follow-up to Phase 5 (ADR-0044): imports `AuditModule` so
 * `OAuthController` can record `AuditEventBatcherService` entries for token
 * issuance/revocation/client registration - closing the gap ADR-0041 left
 * open ("no audit trail exists yet for OAuth token issuance/revocation").
 * Safe in this direction: `AuditModule` depends on neither `IdentityModule`
 * nor `PolicyModule` nor `AuthModule` itself (see `AuditModule`'s own doc
 * comment for why its REST controller was moved out into `AuditApiModule`
 * specifically to keep this edge acyclic).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OAuthClient, UserCredential, SigningKey, AuthorizationCode, RefreshToken]),
    IdentityModule,
    PolicyModule,
    AuditModule,
    TenantSettingsModule,
  ],
  providers: [
    OAuthClientsRepository,
    UserCredentialsRepository,
    SigningKeysRepository,
    AuthorizationCodesRepository,
    RefreshTokensRepository,
    PasswordHasherService,
    SigningKeyService,
    PkceService,
    TokenService,
    TokenRevocationService,
    RefreshTokenService,
    UserContextCacheService,
    OAuthClientAuthService,
    PasswordAuthService,
    AuthorizationCodeService,
    WebAuthnSessionService,
    AuthMethodPolicyService,
    AccessRestrictionPolicyService,
    AccessTokenGuard,
    PermissionsGuard,
  ],
  controllers: [OAuthController, WellKnownController],
  exports: [
    TokenService,
    TokenRevocationService,
    UserContextCacheService,
    SigningKeyService,
    PasswordAuthService,
    OAuthClientsRepository,
    UserCredentialsRepository,
    OAuthClientAuthService,
    AuthorizationCodeService,
    RefreshTokenService,
    PkceService,
    WebAuthnSessionService,
    AuthMethodPolicyService,
    AccessTokenGuard,
    PermissionsGuard,
    PasswordHasherService,
  ],
})
export class AuthModule {}
