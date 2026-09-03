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
import { ComplianceModule } from './compliance/compliance.module';
import { ComplianceGraphQLModule } from './graphql/graphql.module';
import { AdherenceModule } from './adherence/adherence.module';
import { GrpcModule } from './grpc/grpc.module';

/**
 * Module 08 Phase 1 (§7): the `compliance` schema/role (ADR-0093) via
 * `agno_compliance_app`, and the platform's standard observability/
 * tenant-context skeleton.
 *
 * Phase 2 (§3.1/§3.2, ADR-0097): `ComplianceModule` (`ComplianceRule` CRUD +
 * citation enforcement, `createComplianceRule`/`activateComplianceRule`'s
 * pending-review-then-explicit-activation state machine) and
 * `ComplianceGraphQLModule` (this service's primary API surface).
 *
 * Phase 3 (ADR-0098, revising Phase 1's ADR-0094): `ScheduleModule.forRoot()`
 * (this service's first `@nestjs/schedule` usage) and `AdherenceModule` -
 * two `@Cron` jobs reading Module 05's raw `intraday.adherence_event` table
 * directly (not the mutable hourly/daily rollup tables ADR-0094 originally
 * named), via `migratorPoolProvider`.
 *
 * Phase 4 (ADR-0100) adds `GrpcModule` (`ComplianceRuleService.GetActiveRule`/
 * `ValidatePolicyAgainstFloor`, this service's first gRPC server, reusing
 * `ComplianceRuleService`/`resolveEffectiveRules`) and the actual Module
 * 02/04 reconciliation work - Module 02's `EmploymentPoliciesService.create`
 * now calls this service's `ValidatePolicyAgainstFloor` before every write,
 * and scheduling-service's `solve_input_resolver.py` now calls
 * `GetActiveRule` and merges stricter-wins into `EmploymentPolicy`.
 *
 * Phase 5 adds the rule-change impact preview logic. Phase 6 adds
 * `generateComplianceReport`'s async job + S3 export. Phase 7 adds the
 * retention/lifecycle job (ADR-0096), reusing this phase's
 * `ScheduleModule.forRoot()` rather than a second registration.
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
    ComplianceModule,
    ComplianceGraphQLModule,
    AdherenceModule,
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
