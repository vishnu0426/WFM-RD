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
import { IntegrationHubGraphQLModule } from './graphql/graphql.module';
import { SyncModule } from './sync/sync.module';

/**
 * Phase 1 (§7): the `integration_hub` schema/role (ADR-0136) via
 * `agno_integration_hub_app`, and the platform's standard observability/
 * tenant-context skeleton. Phase 2 (§1, ADR-0134/0137) adds
 * `IntegrationHubGraphQLModule` (`createConnector`/`connectors`, and
 * transitively `IntegrationConnectorsModule`'s Vault integration + OAuth
 * callback REST controller) and `SyncModule` (the batch-runner and
 * streaming-relay bases, §5a/§5c). No gRPC server - §3's contracts are
 * GraphQL/REST only; this module is a gRPC *client* of Module 05 (§0/§2.2
 * rule 3b) starting Phase 6, never a gRPC server itself.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    TenantContextModule,
    HealthModule,
    MetricsModule,
    IntegrationHubGraphQLModule,
    SyncModule,
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
