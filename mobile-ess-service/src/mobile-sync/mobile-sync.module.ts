import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthModule } from '../auth/auth.module';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { GeofenceModule } from '../geofence/geofence.module';
import { MobileSyncController } from './mobile-sync.controller';
import { MobileSyncService } from './mobile-sync.service';
import { AttendanceClockEventClient } from './providers/attendance-clock-event-client';
import { LeaveRequestClient } from './providers/leave-request-client';
import { MarketplaceClaimClient } from './providers/marketplace-claim-client';

/**
 * Re-lists `AccessTokenGuard`/`TenantTokenMatchGuard` in this module's own
 * `providers` in addition to importing `AuthModule` - a guard referenced
 * via `@UseGuards(...)` resolves through the *consuming* module's own
 * injector, and ai-layer-service's own disclosed experience is that a
 * guard imported only via a sibling module's `exports` did not resolve
 * reliably in practice (docs/adr/0130). `MetricsModule`/`TenantContextModule`
 * imported directly for the same reason - both guards' own constructor
 * dependencies need to be visible in *this* module's injector context too
 * (real boot failures caught live, not a guess).
 *
 * No `TypeOrmModule.forFeature` (GAP-16 fix, 2026-08-18): `MobileSyncService`
 * injects the root `DataSource` directly and goes through
 * `withTenantConnection` for every query - see that service's own doc
 * comment for why a `forFeature`-bound `Repository` was never safe against
 * this table's RLS policy.
 */
@Module({
  imports: [AuthModule, MetricsModule, TenantContextModule, GeofenceModule, EmployeeGrpcClientModule],
  controllers: [MobileSyncController],
  providers: [
    MobileSyncService,
    AttendanceClockEventClient,
    LeaveRequestClient,
    MarketplaceClaimClient,
    AccessTokenGuard,
    TenantTokenMatchGuard,
  ],
})
export class MobileSyncModule {}
