import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import databaseConfig from './database/typeorm.config';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { HealthModule } from './common/health/health.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { DomainErrorFilter } from './common/http/domain-error.filter';
import { MobileSyncModule } from './mobile-sync/mobile-sync.module';
import { DevicesModule } from './devices/devices.module';
import { PushModule } from './push/push.module';
import { GeofenceModule } from './geofence/geofence.module';

/**
 * Module 11 Phase 3 (docs/adr/0151): the `mobile_ess` schema/role via
 * `agno_mobile_ess_app`, and the platform's standard observability/
 * tenant-context skeleton, same shape every other service's Phase 1
 * `AppModule` follows. `MobileSyncModule` was Phase 3-4's scope - `POST
 * /v1/mobile/sync`. Phase 5 (ADR-0154) added `DevicesModule`
 * (`POST /v1/mobile/devices`, `registerDevice` built as REST not GraphQL,
 * same call ADR-0151 made) and `PushModule` (the NATS-consumer + gRPC
 * preference-check + Expo-push-send pipeline). No GraphQL module in this
 * service at all - deliberately, per every phase's own explicit scoping.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    TenantContextModule,
    MobileSyncModule,
    DevicesModule,
    PushModule,
    GeofenceModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
