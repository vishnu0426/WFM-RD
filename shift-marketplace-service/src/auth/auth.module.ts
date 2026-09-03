import { Module } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard';
import { PermissionsGuard } from './permissions.guard';
import { TenantTokenMatchGuard } from './tenant-token-match.guard';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * Shift Marketplace Manager View phase: this service's first RBAC
 * infrastructure of any kind - every mutation/query before this phase ran
 * with no approver-role check at all (`ApproveMarketplaceActionService`'s
 * own doc comment: "a real RBAC gate belongs to whichever future phase adds
 * real identity verification platform-wide"). This is that phase, for the
 * new manager-only operations only - see `AccessTokenGuard`'s own doc
 * comment for which operations stay ungated and why.
 *
 * Same DI-quirk note as every other copy of this module: a guard referenced
 * via `@UseGuards(SomeGuard)` resolves using the *consuming* module's own
 * injector, so `MarketplaceGraphQLModule` re-lists these three in its own
 * `providers` in addition to importing this module.
 */
@Module({
  imports: [TenantContextModule, MetricsModule],
  providers: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard],
  exports: [AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard],
})
export class AuthModule {}
