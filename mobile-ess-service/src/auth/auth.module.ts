import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * Bundles the guard trio (minus `PermissionsGuard` - see
 * `access-token.guard.ts`'s doc comment for why). Note: NestJS resolves a
 * class referenced via `@UseGuards(SomeGuard)` using the *consuming*
 * module's own injector - a guard imported only via this module's
 * `exports` did not resolve reliably in ai-layer-service's own experience
 * (a disclosed DI quirk, not a documented guarantee). `MobileSyncModule`
 * re-lists `AccessTokenGuard`/`TenantTokenMatchGuard` in its own
 * `providers` in addition to importing this module, for that reason.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [AccessTokenGuard, TenantTokenMatchGuard],
  exports: [AccessTokenGuard, TenantTokenMatchGuard],
})
export class AuthModule {}
