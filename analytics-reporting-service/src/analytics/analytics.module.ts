import { Module } from '@nestjs/common';
import { analyticsAppReplicaPoolProvider } from '../database/analytics-app-replica-pool.provider';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { DashboardService } from './dashboard.service';
import { MetricQueryEngineService } from './metric-query-engine.service';
import { MetricValidationService } from './metric-validation.service';
import { MetricDefinitionService } from './metric-definition.service';
import { ExportStorageService } from './export-storage.service';
import { AnalyticsExportService } from './analytics-export.service';
import { NL_QUERY_BRIDGE_CLIENT } from './nl-query-bridge/nl-query-bridge-client';
import { GrpcNlQueryBridgeClient } from './nl-query-bridge/grpc-nl-query-bridge-client';
import { AskAnalyticsQuestionService } from './ask-analytics-question.service';
import { MetricsController } from './rest/metrics.controller';
import { AnalyticsExportsController } from './rest/analytics-exports.controller';
import { AiLayerGrpcClientModule } from '../grpc/ai-layer-grpc-client.module';

/**
 * Phase 4 (§4, ADR-0108): this module's own domain services -
 * `DashboardService` (CRUD against the primary, via the app's already-
 * registered default `TypeOrmModule` connection - no `forFeature` needed,
 * `@InjectDataSource()` reaches the global connection directly) and
 * `MetricQueryEngineService` (reads against the replica, via its own
 * `ANALYTICS_APP_REPLICA_PG_POOL`). Exported so `graphql/graphql.module.ts`
 * can depend on both without a circular import. `MetricsController` (§4.2's
 * REST BI connector) lives here too, alongside the GraphQL surface's own
 * `metricQuery` - both are thin wrappers over the same service.
 *
 * Phase 5 (§0.5/§2.3 rule 2, ADR-0110) adds `MetricValidationService` (the
 * dry-run/cost-tiering gate, sharing `analyticsAppReplicaPoolProvider` with
 * `MetricQueryEngineService` - one provider, two consumers) and
 * `MetricDefinitionService` (`createMetricDefinition`'s write path).
 *
 * Phase 6 (§4.2/§1) adds `AnalyticsExportService` (the fire-and-forget
 * async export job, reusing `MetricQueryEngineService.queryForExport` -
 * one whitelist check, not a second copy of it), `ExportStorageService`
 * (S3/MinIO), and `AnalyticsExportsController`.
 *
 * Phase 7 (§4.1/§5, ADR-0111) adds `AskAnalyticsQuestionService` and the
 * `NL_QUERY_BRIDGE_CLIENT` provider.
 *
 * ADR-0165 swaps that provider for the real `GrpcNlQueryBridgeClient`
 * (calling Module 10's own new `NlQueryBridgeService` gRPC surface) - the
 * one-line swap ADR-0111 anticipated. `AiLayerGrpcClientModule` imported
 * directly here (not just transitively) for the same reason
 * `AuthModule`/`MetricsModule`/`TenantContextModule` already are: a
 * provider registered in this module's own `providers` resolves its
 * constructor dependencies through *this* module's injector, so
 * `GrpcNlQueryBridgeClient`'s own `AiLayerGrpcClientService` dependency
 * needs its module visible here too, not just in whatever module happens
 * to export it.
 *
 * ADR-0164: `MetricsController`/`AnalyticsExportsController` are now
 * real-RBAC-gated too (`metric_definition:*`/`analytics_export:*`) -
 * `AuthModule` imported for the guard providers, `AccessTokenGuard`/
 * `PermissionsGuard`/`TenantTokenMatchGuard` re-listed in `providers`
 * alongside it (a guard referenced via `@UseGuards(...)` resolves through
 * the *consuming* module's own injector, not the module that originally
 * provided it - `AuthModule`'s own doc comment). `MetricsModule`/
 * `TenantContextModule` were already imported here for unrelated reasons,
 * which is exactly what those guards' own constructor dependencies need
 * visible in this module's context too.
 */
@Module({
  imports: [MetricsModule, TenantContextModule, AuthModule, AiLayerGrpcClientModule],
  controllers: [MetricsController, AnalyticsExportsController],
  providers: [
    analyticsAppReplicaPoolProvider,
    DashboardService,
    MetricQueryEngineService,
    MetricValidationService,
    MetricDefinitionService,
    ExportStorageService,
    AnalyticsExportService,
    { provide: NL_QUERY_BRIDGE_CLIENT, useClass: GrpcNlQueryBridgeClient },
    AskAnalyticsQuestionService,
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
  exports: [
    DashboardService,
    MetricQueryEngineService,
    MetricDefinitionService,
    AnalyticsExportService,
    AskAnalyticsQuestionService,
  ],
})
export class AnalyticsModule {}
