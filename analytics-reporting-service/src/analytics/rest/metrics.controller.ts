import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { MetricQueryEngineService, MetricResultData } from '../metric-query-engine.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

interface MetricsQueryParams {
  periodStart?: string;
  periodEnd?: string;
  orgUnitId?: string;
  costCenter?: string;
  siteOrgUnitId?: string;
  periodType?: string;
  limit?: string;
}

/**
 * §3/§4.2: `GET /v1/analytics/metrics/{metricName}` - the BI-tool
 * connector surface. Reads `analytics_mv.mv_*` **only**, via the exact
 * same `MetricQueryEngineService` the GraphQL `metricQuery` resolver uses
 * - never a live cross-module query, per §3's own instruction ("Tableau/
 * PowerBI polling behavior at customer scale would otherwise reproduce
 * exactly the load problem this design exists to avoid"). `dataAsOf` is
 * present on every returned result (§0.5/§2.3 rule 1).
 *
 * ADR-0164: real-RBAC-gated (`metric_definition:read`) - a BI tool's own
 * connector credential is exactly the kind of long-lived, narrowly-scoped
 * bearer token this guard trio already exists for; this endpoint was the
 * one remaining fully-open surface in Module 09 (ADR-0163's own disclosed
 * scope boundary, closed here alongside `MetricResolver`).
 */
@Controller('v1/analytics/metrics')
export class MetricsController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly metricQueryEngine: MetricQueryEngineService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('metric_definition:read')
  @Get(':metricName')
  async getMetric(
    @Param('metricName') metricName: string,
    @Query() query: MetricsQueryParams,
  ): Promise<{ results: MetricResultData[] }> {
    const tenantId = this.tenantContext.requireTenantId();
    const results = await this.metricQueryEngine.query(tenantId, metricName, {
      periodStart: query.periodStart ? new Date(query.periodStart) : undefined,
      periodEnd: query.periodEnd ? new Date(query.periodEnd) : undefined,
      orgUnitId: query.orgUnitId,
      costCenter: query.costCenter,
      siteOrgUnitId: query.siteOrgUnitId,
      periodType: query.periodType,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return { results };
  }
}
