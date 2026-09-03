import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { PermissionsGuard } from './permissions.guard';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * ADR-0150/ADR-0157. Bundles the guard trio (`PermissionsGuard` added for
 * `GET /v1/leave/requests`/`GET /v1/attendance/exceptions`, Attendance &
 * Leave Manager Views phase), own copy of mobile-ess-service's `AuthModule`.
 * Note: NestJS resolves a class referenced via `@UseGuards(SomeGuard)` using
 * the *consuming* module's own injector - a guard imported only via this
 * module's `exports` did not resolve reliably in ai-layer-service's own
 * experience (a disclosed DI quirk, not a documented guarantee). Consuming
 * modules re-list `AccessTokenGuard`/`TenantTokenMatchGuard`/
 * `PermissionsGuard` in their own `providers` in addition to importing this
 * module, for that reason.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [AccessTokenGuard, TenantTokenMatchGuard, PermissionsGuard],
  exports: [AccessTokenGuard, TenantTokenMatchGuard, PermissionsGuard],
})
export class AuthModule {}
