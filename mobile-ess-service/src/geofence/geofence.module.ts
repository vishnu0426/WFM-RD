import { Module } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthModule } from '../auth/auth.module';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { PolicyGrpcClientModule } from '../grpc/policy-grpc-client.module';
import { GeofenceConfigController } from './geofence-config.controller';
import { GeofenceVerificationService } from './geofence-verification.service';

/**
 * ADR-0155. Re-lists `AccessTokenGuard`/`TenantTokenMatchGuard` in this
 * module's own `providers` in addition to importing `AuthModule`, same
 * DI-resolution reason `MobileSyncModule`/`DevicesModule` already
 * document (docs/adr/0130). `MetricsModule` imported directly too -
 * re-listing the guard classes alone isn't sufficient, `AccessTokenGuard`'s
 * own `MetricsService` dependency needs its module visible in *this*
 * module's own injector context (a real boot failure caught live, the
 * same fix `DevicesModule`/`MobileSyncModule` needed for the identical
 * quirk), and so does `TenantContextModule` for `TenantTokenMatchGuard`'s
 * own `TenantContextService` dependency. Exports `GeofenceVerificationService`
 * - `MobileSyncModule`'s own `processClockEvent` is this module's other
 * consumer.
 */
@Module({
  imports: [AuthModule, MetricsModule, TenantContextModule, EmployeeGrpcClientModule, PolicyGrpcClientModule],
  controllers: [GeofenceConfigController],
  providers: [GeofenceVerificationService, AccessTokenGuard, TenantTokenMatchGuard],
  exports: [GeofenceVerificationService],
})
export class GeofenceModule {}
