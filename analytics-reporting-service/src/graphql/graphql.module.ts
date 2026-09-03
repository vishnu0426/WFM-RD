import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { DomainError } from '../common/errors/domain-error';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { JsonScalar } from './json.scalar';
import { DashboardResolver } from './resolvers/dashboard.resolver';
import { MetricResolver } from './resolvers/metric.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - own copy of adherence-compliance-service's/shift-marketplace-service's `formatGraphQLError`. */
function formatGraphQLError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original =
    error instanceof Error && 'originalError' in error ? (error as { originalError?: unknown }).originalError : error;
  if (original instanceof DomainError) {
    return {
      ...formattedError,
      message: original.message,
      extensions: { code: original.code },
    };
  }
  return formattedError;
}

/**
 * Phase 4 (§4.1): this service's primary API surface -
 * `dashboard`/`myDashboards`/`createDashboard`/`updateDashboard`
 * (`DashboardResolver`) and `metricQuery`/`executiveSummary`/
 * `metricDefinitions`/`createMetricDefinition`/`askAnalyticsQuestion`
 * (`MetricResolver`). No subscriptions - nothing in this module's spec
 * calls for real-time push. `createScheduledExport` has no GraphQL surface
 * at all - exports are REST-only (`AnalyticsExportsController`), see that
 * controller's own doc comment.
 *
 * ADR-0163: `DashboardResolver`'s four operations are real-RBAC-gated
 * (`AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`,
 * `dashboard:read`/`dashboard:write`) - `MetricResolver` remains ungated,
 * a deliberate scope boundary the ADR explains.
 */
@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      formatError: formatGraphQLError,
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    TenantContextModule,
    MetricsModule,
    AnalyticsModule,
    AuthModule,
  ],
  providers: [
    JsonScalar,
    DashboardResolver,
    MetricResolver,
    // Re-provided here alongside AuthModule (which also provides+exports
    // them) - same fix adherence-compliance-service's/ai-layer-service's
    // own GraphQL modules already document: NestJS resolves a class
    // referenced via `@UseGuards(SomeGuard)` using the *consuming*
    // module's own injector, and a guard imported only via a sibling
    // module's `exports` doesn't resolve reliably here in practice - this
    // was missing and broke boot (`AccessTokenGuard`'s own `MetricsService`
    // dependency couldn't resolve in AnalyticsGraphQLModule's context).
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
})
export class AnalyticsGraphQLModule {}
