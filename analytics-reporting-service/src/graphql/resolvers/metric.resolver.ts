import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { MetricQueryEngineService, ExecutiveSummaryPeriod } from '../../analytics/metric-query-engine.service';
import { MetricDefinitionService } from '../../analytics/metric-definition.service';
import { AskAnalyticsQuestionService } from '../../analytics/ask-analytics-question.service';
import {
  MetricResultType,
  MetricQueryFilterInputType,
  MetricDefinitionResult,
  CreateMetricDefinitionInputType,
  AnalyticsAnswerResult,
  toMetricResultType,
  toMetricDefinitionResult,
  toAnalyticsAnswerResult,
} from '../../analytics/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §4.1's `metricQuery`/`executiveSummary`, plus `createMetricDefinition`
 * (Phase 5, ADR-0110 - §4.1 never named this mutation; added because
 * Phase 5's validation pipeline needs a real write path to validate) and
 * `askAnalyticsQuestion` (Phase 7, ADR-0111; real Module 10 backing as of
 * ADR-0165). `MetricDefinition` has no `createdBy` concept and
 * `askAnalyticsQuestion`'s own `AnalyticsAnswer` isn't persisted, so unlike
 * `DashboardResolver`, tenant scope alone (still via `TenantContextService`/
 * `X-Tenant-Id`, cross-checked against the JWT's own `tenant_id` claim by
 * `TenantTokenMatchGuard`) is what every one of these five operations
 * authorizes against - `askAnalyticsQuestion` additionally reads
 * `claims.sub` (ADR-0165) purely to attribute the call to Module 10's own
 * `AiInteraction`/rate-limiting, same posture `AnalyticsExportsController`
 * already takes for `requestedBy`.
 *
 * ADR-0164: real-RBAC-gated (ADR-0163's own disclosed scope boundary,
 * closed here) - every read (`metricQuery`/`executiveSummary`/
 * `metricDefinitions`/`askAnalyticsQuestion`) needs `metric_definition:read`,
 * the one write (`createMetricDefinition`) needs `metric_definition:write`.
 * `askAnalyticsQuestion` is grouped under `metric_definition:read` rather
 * than a dedicated resource - it has no state of its own to protect
 * (`AnalyticsAnswer` isn't persisted), it only ever executes the same
 * `metricQuery`/`executiveSummary` read path this resolver's other queries
 * already gate identically.
 */
@Resolver()
export class MetricResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly metricQueryEngine: MetricQueryEngineService,
    private readonly metricDefinitionService: MetricDefinitionService,
    private readonly askAnalyticsQuestionService: AskAnalyticsQuestionService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:read')
  @Query(() => [MetricResultType], { name: 'metricQuery' })
  async metricQuery(
    @Args('metricName') metricName: string,
    @Args('filter', { nullable: true }) filter?: MetricQueryFilterInputType,
  ): Promise<MetricResultType[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const results = await this.metricQueryEngine.query(tenantId, metricName, filter ?? {});
    return results.map(toMetricResultType);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:read')
  @Query(() => [MetricResultType], { name: 'executiveSummary' })
  async executiveSummary(
    @Args('orgUnitId', { type: () => ID, nullable: true }) orgUnitId: string | undefined,
    @Args('period', { type: () => ExecutiveSummaryPeriod }) period: ExecutiveSummaryPeriod,
  ): Promise<MetricResultType[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const results = await this.metricQueryEngine.executiveSummary(tenantId, orgUnitId, period);
    return results.map(toMetricResultType);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:write')
  @Mutation(() => MetricDefinitionResult, { name: 'createMetricDefinition' })
  async createMetricDefinition(@Args('input') input: CreateMetricDefinitionInputType): Promise<MetricDefinitionResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const definition = await this.metricDefinitionService.createMetricDefinition(tenantId, input);
    return toMetricDefinitionResult(definition);
  }

  /** Structurally necessary alongside `createMetricDefinition` - see `MetricDefinitionService.listVisibleMetrics`'s own doc comment. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:read')
  @Query(() => [MetricDefinitionResult], { name: 'metricDefinitions' })
  async metricDefinitions(): Promise<MetricDefinitionResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const definitions = await this.metricDefinitionService.listVisibleMetrics(tenantId);
    return definitions.map(toMetricDefinitionResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:read')
  @Mutation(() => AnalyticsAnswerResult, { name: 'askAnalyticsQuestion' })
  async askAnalyticsQuestion(
    @Args('question') question: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<AnalyticsAnswerResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const answer = await this.askAnalyticsQuestionService.ask(tenantId, claims.sub ?? null, question);
    return toAnalyticsAnswerResult(answer);
  }
}
