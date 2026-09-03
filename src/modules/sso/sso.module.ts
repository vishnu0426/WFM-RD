import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantIdentityProvider } from './entities/tenant-identity-provider.entity';
import { TenantIdentityProvidersRepository } from './repositories/tenant-identity-providers.repository';
import { TenantIdentityProviderService } from './services/tenant-identity-provider.service';
import { SamlService } from './services/saml.service';
import { OidcFederationService } from './services/oidc-federation.service';
import { SsoLoginService } from './services/sso-login.service';
import { TenantIdentityProvidersController } from './rest/tenant-identity-providers.controller';
import { SsoController } from './rest/sso.controller';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Module 01 Phase 3 (§8): §5.5's per-tenant SSO federation
 * (SAML 2.0 + generic OIDC). See docs/phase-3-design-doc.md.
 *
 * Follow-up to Phase 5 (ADR-0044): imports `AuditModule` - `SsoController`
 * records a fire-and-forget `AuditEventBatcherService` entry on a
 * successful federated login, and `TenantIdentityProvidersController`
 * records a synchronous `AuditLogRepository` entry on every IdP config
 * mutation (matching `RoleManagementController`'s admin-CRUD pattern) -
 * closing the gap ADR-0041 left open for SSO. No cycle risk: `AuditModule`
 * depends on neither `AuthModule` nor `IdentityModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TenantIdentityProvider]), AuthModule, IdentityModule, AuditModule],
  providers: [
    TenantIdentityProvidersRepository,
    TenantIdentityProviderService,
    SamlService,
    OidcFederationService,
    SsoLoginService,
  ],
  controllers: [TenantIdentityProvidersController, SsoController],
  exports: [TenantIdentityProvidersRepository],
})
export class SsoModule {}
