import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { PermissionsGuard } from './permissions.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * ADR-0163: own copy of the same `AuthModule` shape every other RBAC-gated
 * service in this platform uses (ADR-0130/ADR-0145/ADR-0161) -
 * `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard` as real
 * providers, exported for any resolver/controller module to
 * `@UseGuards(...)` against. `RequirePermissions`/`CurrentTokenClaims` are
 * plain decorator factories, not providers - nothing to register for
 * either.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard],
  exports: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard],
})
export class AuthModule {}
