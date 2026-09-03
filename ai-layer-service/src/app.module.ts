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
import { AiModule } from './ai/ai.module';
import { AiGraphQLModule } from './graphql/graphql.module';
import { GrpcModule } from './grpc/grpc.module';

/**
 * Module 10 Phase 1 (§9 Phase 1, docs/adr/0113): the `ai_layer` schema/role
 * via `agno_ai_app`, and the platform's standard observability/tenant-
 * context skeleton - same shape as every other module's own Phase 1
 * `AppModule`.
 *
 * Phase 2 (§9 Phase 2, docs/adr/0115/0116) adds this module's first real
 * capability: `AiModule` (the `explainSchedule` pipeline - gRPC-retrieve
 * from scheduling-service -> §5.1 tenant-scoping assertion -> Anthropic
 * `/v1/messages` call -> `AIInteraction` persistence -> audit + write-back)
 * and `AiGraphQLModule` (`explainSchedule`) - where `TenantContextModule`/
 * `DomainErrorFilter` actually start seeing traffic for the first time.
 *
 * No `ScheduleModule.forRoot()`/cron jobs yet (unlike Module 08/09's own
 * Phase 1) - nothing in this phase runs on a schedule; every interaction is
 * request-driven.
 *
 * ADR-0165 adds `GrpcModule` (`NlQueryBridgeService.TranslateQuestion`/
 * `GenerateAnswer`) - this module's first inbound gRPC surface; see
 * `main.ts`'s own updated doc comment for why that reverses this file's
 * original "GraphQL only, gRPC only as an outbound client" framing.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    TenantContextModule,
    AiModule,
    AiGraphQLModule,
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
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
