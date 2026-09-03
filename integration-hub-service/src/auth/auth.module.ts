import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { PermissionsGuard } from './permissions.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * §7 Phase 8 (ADR-0145): own copy of ai-layer-service's `AuthModule` -
 * `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard` as real
 * providers, exported for any resolver module to `@UseGuards(...)` against.
 * `RequirePermissions`/`CurrentTokenClaims` are plain decorator factories,
 * not providers - nothing to register for either.
 *
 * `PlatformAdminGuard` added for the Tenant Monitoring onboarding "Data
 * Sources" step's cross-tenant connector-provisioning endpoint - used
 * instead of `TenantTokenMatchGuard` there, never alongside it.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, PlatformAdminGuard],
  exports: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard, PlatformAdminGuard],
})
export class AuthModule {}
