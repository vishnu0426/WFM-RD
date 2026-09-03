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
import { RefreshModule } from './refresh/refresh.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AnalyticsGraphQLModule } from './graphql/graphql.module';
import { TenantMonitoringModule } from './tenant-monitoring/tenant-monitoring.module';

/**
 * Module 09 Phase 1 (§7, ADR-0108): the `analytics`/`analytics_mv` schemas/
 * role via `agno_analytics_app`, and the platform's standard observability/
 * tenant-context skeleton.
 *
 * Phase 2 (§8, ADR-0108) adds `ScheduleModule.forRoot()` (this service's
 * first `@nestjs/schedule` usage) and `RefreshModule` - the materialized-
 * view refresh runner, reading Module 08/03's data via `agno_migrator`
 * against the analytics read replica and writing `mv_adherence_trend_rollup`/
 * `mv_forecast_accuracy_trend` back via `agno_migrator` against the
 * primary (not `agno_analytics_app` - see `RefreshModule`'s own doc
 * comment for why this differs from Phase 1's original framing).
 *
 * Phase 3 adds the cross-module views (`mv_cost_vs_budget`/
 * `mv_attrition_by_site`).
 *
 * Phase 4 (§4, §8 Phase 4, ADR-0108) adds this service's primary API
 * surface: `AnalyticsModule` (`DashboardService`/`MetricQueryEngineService`/
 * the REST BI-connector controller) and `AnalyticsGraphQLModule`
 * (`dashboard`/`myDashboards`/`createDashboard`/`metricQuery`/
 * `executiveSummary`) - where `TenantContextModule`/`DomainErrorFilter`
 * actually start seeing traffic for the first time.
 *
 * Phase 5 adds the custom-metric validation pipeline. Phase 6 adds the
 * async export job (`POST /v1/analytics/exports`). Phase 7 adds the NL
 * query bridge to Module 10 (`askAnalyticsQuestion`). Phase 8 closes out
 * this module's 8-phase build with load testing/observability/hardening.
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
    RefreshModule,
    AnalyticsModule,
    AnalyticsGraphQLModule,
    TenantMonitoringModule,
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
