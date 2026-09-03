import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import databaseConfig from './database/typeorm.config';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { HealthModule } from './common/health/health.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { DomainErrorFilter } from './common/http/domain-error.filter';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { MarketplaceGraphQLModule } from './graphql/graphql.module';

/**
 * Phase 1 (§8): the `marketplace` schema/role (ADR-0083) via
 * `agno_marketplace_app`, and the platform's standard observability/
 * tenant-context skeleton.
 *
 * Phase 2 (§4, ADR-0084/0085/0086): `MarketplaceModule` (Redis distributed
 * lock, the Module 04 `SchedulingEligibilityService` gRPC client, the
 * concurrency-safe claim flow) and `MarketplaceGraphQLModule` (this
 * service's primary API surface, including the `marketplacePostUpdated`
 * subscription).
 *
 * Phase 4 (ADR-0087/0088): `ScheduleModule.forRoot()` - this service's
 * first `@Cron` usage (`BidCloseSweepService`), mirroring core/intraday-
 * service/attendance-leave-service's own convention. NATS (Phase 5) and
 * BullMQ (Phase 6) still aren't wired - each lands with whichever later
 * phase first needs it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    ScheduleModule.forRoot(),
    TenantContextModule,
    MarketplaceModule,
    MarketplaceGraphQLModule,
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
