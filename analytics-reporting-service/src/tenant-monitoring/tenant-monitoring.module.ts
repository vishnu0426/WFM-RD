import { Module } from '@nestjs/common';
import { analyticsAppReplicaPoolProvider } from '../database/analytics-app-replica-pool.provider';
import { MetricsModule } from '../common/metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { TenantMonitoringService } from './tenant-monitoring.service';
import { TenantMonitoringController } from './rest/tenant-monitoring.controller';

/**
 * Tenant Monitoring dashboard (internal CS tool). Own copy of
 * `analyticsAppReplicaPoolProvider` rather than importing `AnalyticsModule`
 * for it (`AnalyticsModule` doesn't export that provider, only its
 * services) - same "each module owns its own copy of shared infra
 * providers" precedent `RefreshModule`'s own doc comment documents for the
 * migrator pools. `AccessTokenGuard`/`PermissionsGuard`/`PlatformAdminGuard`
 * re-listed in `providers` alongside `AuthModule`, same reason
 * `AnalyticsModule` re-lists its own guard trio: a guard referenced via
 * `@UseGuards(...)` resolves through the *consuming* module's own injector.
 */
@Module({
  imports: [MetricsModule, AuthModule],
  controllers: [TenantMonitoringController],
  providers: [analyticsAppReplicaPoolProvider, TenantMonitoringService, AccessTokenGuard, PermissionsGuard, PlatformAdminGuard],
})
export class TenantMonitoringModule {}
