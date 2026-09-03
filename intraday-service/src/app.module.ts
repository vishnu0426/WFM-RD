import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import databaseConfig from './database/typeorm.config';
import { IntradayRedisModule } from './redis/redis.module';
import { IntradayNatsModule } from './nats/nats.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { IngestionCredentialsModule } from './ingestion-credentials/ingestion-credentials.module';
import { ConsumersModule } from './consumers/consumers.module';
import { ScheduledActivityModule } from './schedule/scheduled-activity.module';
import { AdherenceModule } from './adherence/adherence.module';
import { IntradayGraphQLModule } from './graphql/graphql.module';
import { GrpcModule } from './grpc/grpc.module';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { HealthModule } from './common/health/health.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { DomainErrorFilter } from './common/http/domain-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    // Phase 2: backs `ShiftStartPreloadSchedulerService`'s `@Cron` tick.
    // Phase 3: also backs the two adherence scheduler services.
    ScheduleModule.forRoot(),
    // Phase 3 (ADR-0066): the runtime `agno_intraday_app` connection - see
    // `database/typeorm.config.ts` and `database/migrator-pool.provider.ts`
    // for the (deliberately separate) migrator-credentialed pool the two
    // adherence scheduler services use instead of this one.
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    TenantContextModule,
    IntradayRedisModule,
    IntradayNatsModule,
    IngestionModule,
    IngestionCredentialsModule,
    ConsumersModule,
    ScheduledActivityModule,
    AdherenceModule,
    // Phase 4: LiveStateModule (REST snapshot controller) is pulled in
    // transitively via IntradayGraphQLModule's own imports.
    IntradayGraphQLModule,
    // Module 10 Phase 4 (docs/adr/0120): this service's first gRPC surface.
    GrpcModule,
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
    // Phase 4: header-trust tenant binding for the new GraphQL/REST-snapshot
    // surface - see TenantContextMiddleware's own doc comment for why this
    // is safe to apply broadly (it never rejects a request itself; the
    // ingestion webhook path never calls `requireTenantId()`, so it's
    // unaffected).
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
