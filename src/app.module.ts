import { join } from 'path';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import databaseConfig from './database/typeorm.config';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantContextMiddleware } from './common/http/tenant-context.middleware';
import { MaintenanceModeMiddleware } from './common/http/maintenance-mode.middleware';
import { DomainErrorFilter } from './common/http/domain-error.filter';
import { DomainError } from './common/errors/domain-error';
import { IdempotencyInterceptor } from './common/http/idempotency.interceptor';
import { JsonScalar } from './common/graphql/json.scalar';
import { RedisModule } from './common/redis/redis.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { IdentityModule } from './modules/identity/identity.module';
import { PolicyModule } from './modules/policy/policy.module';
import { AuditApiModule } from './modules/audit-api.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AuthModule } from './modules/auth/auth.module';
import { SsoModule } from './modules/sso/sso.module';
import { WebAuthnModule } from './modules/webauthn/webauthn.module';
import { ScimModule } from './modules/scim/scim.module';
import { SkillModule } from './modules/skill/skill.module';
import { EmployeeGroupModule } from './modules/employee-group/employee-group.module';
import { WorkRuleModule } from './modules/work-rule/work-rule.module';
import { SchedulePreferenceModule } from './modules/schedule-preference/schedule-preference.module';
import { EmployeeInteractionModule } from './modules/employee-interaction/employee-interaction.module';
import { TimeBankModule } from './modules/employee/time-bank.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { OrgApiModule } from './modules/org-api.module';
import { PolicyApiModule } from './modules/policy-api.module';
import { IdentityApiModule } from './modules/identity-api.module';
import { EventingModule } from './modules/eventing/eventing.module';
import { CoreEventingModule } from './modules/core-eventing/core-eventing.module';
import { BulkImportModule } from './modules/bulk-import/bulk-import.module';
import { TenantApiModule } from './modules/tenant-api.module';
import { TenantSettingsApiModule } from './modules/tenant-settings-api.module';
import { WebhookApiModule } from './modules/webhook-api.module';
import { PlatformGraphQLModule } from './modules/platform-graphql.module';
import { HealthModule } from './common/health/health.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { GrpcModule } from './grpc/grpc.module';

/**
 * GraphQL error formatting counterpart to `DomainErrorFilter` (REST) -
 * Nest's `APP_FILTER` exception filters don't intercept GraphQL resolver
 * errors the same way, so `DomainError` -> stable `extensions.code` mapping
 * lives here instead, in the code-first Apollo driver config.
 *
 * Audit gap-fix: for every OTHER error (an unhandled TypeORM/pg exception,
 * a guard's `UnauthorizedException`, anything not a `DomainError`), this
 * used to fall through to `formattedError` unchanged - Apollo's own
 * `NODE_ENV`-gated default, which includes `extensions.stacktrace` (real
 * file paths, class/method names) unless `NODE_ENV=production` at deploy
 * time. That's an ops setting this repo has no code-level guarantee of, so
 * relying on it alone left every non-DomainError response leaking internals
 * to any caller (including unauthenticated ones - confirmed live: a
 * request with no Bearer token got back a full stack trace for
 * `AccessTokenGuard.canActivate`). Strip `extensions.exception`/
 * `stacktrace` unconditionally here instead of trusting deployment config -
 * defense in depth, not a substitute for also setting
 * `NODE_ENV=production` in real deployments.
 */
function formatGraphQLError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original =
    error instanceof Error && 'originalError' in error ? (error as { originalError?: unknown }).originalError : error;
  if (original instanceof DomainError) {
    return {
      ...formattedError,
      message: original.message,
      extensions: { code: original.code, details: original.details ?? null },
    };
  }
  const { exception: _exception, stacktrace: _stacktrace, ...safeExtensions } = formattedError.extensions ?? {};
  return { ...formattedError, extensions: safeExtensions };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    // Backs SkillDecaySchedulerService's @Cron tick (§5, ADR-0017).
    ScheduleModule.forRoot(),
    // Serves `EmployeeAvatarController`'s uploads (`<repo-root>/uploads/avatars/*`)
    // back out at `/uploads/*`. `process.cwd()`, not `__dirname` - this repo
    // already assumes it's always launched from the repo root (see main.ts's
    // relative `.env` loading), and `__dirname` would otherwise resolve
    // differently under `ts-node`/`nest start --watch` (source tree) than
    // after `nest build` (`dist/`), needing two different relative offsets.
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      formatError: formatGraphQLError,
      // Explicit (matches Apollo's own default shape) rather than relying on
      // the default, since AccessTokenGuard/PermissionsGuard's GraphQL path
      // (Phase 6) depends on `GqlExecutionContext.getContext().req` existing.
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    TenantContextModule,
    RedisModule,
    TenantModule,
    IdentityModule,
    PolicyModule,
    AuditApiModule,
    NotificationModule,
    AuthModule,
    SsoModule,
    WebAuthnModule,
    ScimModule,
    SkillModule,
    EmployeeGroupModule,
    WorkRuleModule,
    SchedulePreferenceModule,
    EmployeeInteractionModule,
    TimeBankModule,
    CalendarModule,
    OrgApiModule,
    PolicyApiModule,
    IdentityApiModule,
    EventingModule,
    CoreEventingModule,
    BulkImportModule,
    TenantApiModule,
    TenantSettingsApiModule,
    WebhookApiModule,
    PlatformGraphQLModule,
    HealthModule,
    MetricsModule,
    GrpcModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    JsonScalar,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // MaintenanceModeMiddleware runs after TenantContextMiddleware —
    // it needs tenant context already bound to know which tenant's
    // Maintenance Mode policy to check (see its own doc comment).
    consumer.apply(TenantContextMiddleware, MaintenanceModeMiddleware).forRoutes('*');
  }
}
