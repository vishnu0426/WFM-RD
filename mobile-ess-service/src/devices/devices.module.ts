import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthModule } from '../auth/auth.module';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/**
 * Re-lists `AccessTokenGuard`/`TenantTokenMatchGuard` in this module's own
 * `providers`, same DI-resolution reason `MobileSyncModule` documents
 * (docs/adr/0130). Exports `DevicesService` - `PushModule`'s
 * `PushDispatchService` (ADR-0154 §B) is this module's own consumer.
 *
 * `MetricsModule` imported directly too (not just transitively through
 * `AuthModule`) - re-listing the guard classes alone isn't sufficient,
 * `AccessTokenGuard`'s own `MetricsService` dependency needs its module
 * available in *this* module's own injector context. A real boot failure
 * ("Nest can't resolve dependencies of the AccessTokenGuard... MetricsService...
 * in DevicesModule context"), not a guess - the same fix
 * analytics-reporting-service's/shift-marketplace-service's own GraphQL
 * modules needed for the identical DI quirk. `TenantContextModule`
 * imported directly too - `TenantTokenMatchGuard`'s own `TenantContextService`
 * dependency has the identical resolution requirement, caught by the very
 * next boot attempt once the `MetricsService` gap above was fixed.
 *
 * No `TypeOrmModule.forFeature` (GAP-16 fix, 2026-08-18): `DevicesService`
 * injects the root `DataSource` directly and goes through
 * `withTenantConnection` for every query - see that service's own doc
 * comment for why a `forFeature`-bound `Repository` was never safe against
 * this table's RLS policy.
 */
@Module({
  imports: [AuthModule, MetricsModule, TenantContextModule, EmployeeGrpcClientModule],
  controllers: [DevicesController],
  providers: [DevicesService, AccessTokenGuard, TenantTokenMatchGuard],
  exports: [DevicesService],
})
export class DevicesModule {}
