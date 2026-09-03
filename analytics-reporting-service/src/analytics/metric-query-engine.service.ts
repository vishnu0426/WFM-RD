import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Pool } from 'pg';
import { ANALYTICS_APP_REPLICA_PG_POOL } from '../database/analytics-app-replica-pool.provider';
import { withTenantConnection } from '../database/with-tenant-connection';
import { withTenantScopedClient } from '../database/with-tenant-scoped-client';
import { MetricDefinition, MetricCostTier } from './entities/metric-definition.entity';
import { MetricNotFoundError, MetricSourceNotAllowedError } from './errors/metric-not-found.error';
import { SOURCE_VIEW_REGISTRY } from './source-view-registry';
import { MetricsService } from '../common/metrics/metrics.service';

export enum ExecutiveSummaryPeriod {
  CURRENT_MONTH = 'current_month',
  LAST_MONTH = 'last_month',
  LAST_QUARTER = 'last_quarter',
}

export interface MetricQueryFilter {
  periodStart?: Date;
  periodEnd?: Date;
  orgUnitId?: string;
  costCenter?: string;
  siteOrgUnitId?: string;
  periodType?: string;
  limit?: number;
}

export interface MetricResultData {
  metric: string;
  value: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  comparisonPeriodValue: number | null;
  periodStart: Date;
  periodEnd: Date;
  dataAsOf: Date | null;
}

interface DimensionColumn {
  filterKey: keyof MetricQueryFilter;
  column: string;
  cast: 'uuid' | 'varchar';
}

// One entry per real column any registered view's `allowedDimensions`
// names (source-view-registry.ts) - a dimension not listed here can never
// be filtered on, no matter what a MetricDefinition's jsonb claims.
const DIMENSION_COLUMNS: Record<string, DimensionColumn> = {
  period_type: { filterKey: 'periodType', column: 'period_type', cast: 'varchar' },
  org_unit_id: { filterKey: 'orgUnitId', column: 'org_unit_id', cast: 'uuid' },
  cost_center: { filterKey: 'costCenter', column: 'cost_center', cast: 'varchar' },
  site_org_unit_id: { filterKey: 'siteOrgUnitId', column: 'site_org_unit_id', cast: 'uuid' },
};

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
// Phase 6: an export exists specifically for the "large multi-year pull"
// case the live-read path's MAX_LIMIT deliberately excludes (§1: "Async
// job... Synchronous generation of large multi-year exports [not
// allowed]"). Still bounded - a disclosed placeholder ceiling, not
// genuinely unbounded, so a single export can never produce an unbounded
// CSV even across a multi-year date range.
const EXPORT_MAX_ROWS = 10_000;

interface ResolvedMetric {
  definition: MetricDefinition;
  spec: { table: string; allowedDimensions: string[] };
  valueColumn: string;
}

/**
 * Phase 4 (§3/§4, ADR-0108): the metric query engine. Looks up a
 * `MetricDefinition` by name (tenant override if one exists, else the
 * platform default - Phase 5 is the first phase that could ever write a
 * tenant-specific row), validates its `calculationDefinition` against
 * `SOURCE_VIEW_REGISTRY`'s whitelist, then reads `analytics_mv.mv_*`
 * **only** (§3: "must read from these materialized views, not trigger a
 * live cross-module query") via `ANALYTICS_APP_REPLICA_PG_POOL` - the
 * replica connection ADR-0108 names as this module's load-isolation
 * mechanism, RLS-scoped per request via `withTenantScopedClient`.
 *
 * `dataAsOf` is read from `mv_lineage` on the **same** replica connection
 * (`mv_lineage` has no RLS - it is schema metadata, not tenant data) -
 * never fabricated, and left `null` if that view has genuinely never
 * refreshed (§2.3 rule 1's own honesty requirement, restated for the read
 * side rather than the write side Phase 2/3 already cover).
 */
@Injectable()
export class MetricQueryEngineService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ANALYTICS_APP_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  async query(tenantId: string, metricName: string, filter: MetricQueryFilter = {}): Promise<MetricResultData[]> {
    const { definition, spec, valueColumn, sourceView } = await this.resolveMetric(tenantId, metricName);
    const costTier = definition.estimatedCostTier ?? MetricCostTier.CHEAP;

    try {
      const results = await withTenantScopedClient(this.replicaPool, tenantId, async (client) => {
        const { rows, requestedLimit } = await this.readRows(client, spec, valueColumn, filter);
        const dataAsOf = await this.readDataAsOf(client, sourceView);
        return shapeResults(metricName, rows, requestedLimit, dataAsOf);
      });
      this.metrics.metricQueriesTotal.inc({ cost_tier: costTier, result: 'success' });
      return results;
    } catch (err) {
      this.metrics.metricQueriesTotal.inc({ cost_tier: costTier, result: 'error' });
      throw err;
    }
  }

  /**
   * Phase 6 (§1/§4.2): the export job's own read - reuses this exact
   * `resolveMetric` whitelist check (never a second, drifting copy of it),
   * but selects every one of the view's dimension columns (not just the
   * one `value` column `query()` needs) and applies no `+1`-row trend
   * trick - an export is a flat table, not a comparison series. Bounded
   * at `EXPORT_MAX_ROWS`, still never a live cross-module query (§3) -
   * reads `analytics_mv.mv_*` via the same replica connection.
   */
  async queryForExport(
    tenantId: string,
    metricName: string,
    filter: MetricQueryFilter = {},
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; dataAsOf: Date | null }> {
    const { spec, valueColumn, sourceView } = await this.resolveMetric(tenantId, metricName);
    const columns = ['period_start', 'period_end', ...spec.allowedDimensions, valueColumn];

    return withTenantScopedClient(this.replicaPool, tenantId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      appendPeriodConditions(conditions, params, filter);
      appendDimensionConditions(conditions, params, spec, filter);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `
        SELECT ${columns.join(', ')}
        FROM ${spec.table}
        ${whereClause}
        ORDER BY period_start DESC
        LIMIT ${EXPORT_MAX_ROWS};
      `;
      const { rows } = await client.query(sql, params);
      const dataAsOf = await this.readDataAsOf(client, sourceView);
      return { columns, rows, dataAsOf };
    });
  }

  /**
   * §4.1's `executiveSummary(orgUnitId, period)`. Only includes metrics
   * whose grain actually matches "org unit + period": `adherence_trend`
   * (tenant-wide by construction, always included) and, when `orgUnitId`
   * is supplied, `forecast_accuracy_mape`/`attrition_terminations` (exact
   * match against `org_unit_id`/`site_org_unit_id` - no ancestor
   * resolution the way `mv_attrition_by_site`'s own refresh job resolves
   * an employee's site; a business-unit-level `orgUnitId` that isn't
   * itself the `site_org_unit_id` on file simply returns no attrition
   * row, not a fabricated one).
   *
   * **Deliberately excludes `scheduled_hours`/`overtime_hours`/
   * `approved_leave_days`** - `mv_cost_vs_budget` is grouped by
   * `cost_center`, not `org_unit_id`; there is no tenant-wide or
   * org-unit-scoped total to return without summing across cost centers,
   * which this query engine's per-row read does not do. A named scope
   * limitation (`docs/module-09-phase-4-production-readiness-checklist.md`),
   * not an oversight.
   */
  async executiveSummary(
    tenantId: string,
    orgUnitId: string | undefined,
    period: ExecutiveSummaryPeriod,
  ): Promise<MetricResultData[]> {
    const { periodStart, periodEnd } = resolvePeriodBounds(period);
    const results: MetricResultData[] = [];

    results.push(
      ...(await this.query(tenantId, 'adherence_trend', { periodStart, periodEnd, periodType: 'month', limit: 1 })),
    );

    if (orgUnitId) {
      results.push(
        ...(await this.query(tenantId, 'forecast_accuracy_mape', { periodStart, periodEnd, orgUnitId, limit: 1 })),
      );
      results.push(
        ...(await this.query(tenantId, 'attrition_terminations', {
          periodStart,
          periodEnd,
          siteOrgUnitId: orgUnitId,
          limit: 1,
        })),
      );
    }

    return results;
  }

  /**
   * The one place `calculationDefinition.sourceView`/`valueColumn` is
   * validated against `SOURCE_VIEW_REGISTRY` - both `query()` and
   * `queryForExport()` (Phase 6) call this, never re-implement the check.
   */
  private async resolveMetric(tenantId: string, metricName: string): Promise<ResolvedMetric & { sourceView: string }> {
    const definition = await this.findVisibleMetricByName(tenantId, metricName);
    const definitionShape = definition.calculationDefinition as { sourceView: string; valueColumn: string };
    const spec = SOURCE_VIEW_REGISTRY[definitionShape.sourceView];
    if (!spec || !spec.allowedValueColumns.includes(definitionShape.valueColumn)) {
      throw new MetricSourceNotAllowedError(metricName);
    }
    return { definition, spec, valueColumn: definitionShape.valueColumn, sourceView: definitionShape.sourceView };
  }

  private async findVisibleMetricByName(tenantId: string, name: string): Promise<MetricDefinition> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const tenantSpecific = await manager.findOne(MetricDefinition, { where: { name, tenantId } });
      if (tenantSpecific) {
        return tenantSpecific;
      }
      const platformDefault = await manager.findOne(MetricDefinition, { where: { name, tenantId: IsNull() } });
      if (!platformDefault) {
        throw new MetricNotFoundError(name);
      }
      return platformDefault;
    });
  }

  private async readRows(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: SourceRow[] }> },
    spec: { table: string; allowedDimensions: string[] },
    valueColumn: string,
    filter: MetricQueryFilter,
  ): Promise<{ rows: SourceRow[]; requestedLimit: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    appendPeriodConditions(conditions, params, filter);
    appendDimensionConditions(conditions, params, spec, filter);

    const requestedLimit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT period_start, period_end, ${valueColumn} AS value
      FROM ${spec.table}
      ${whereClause}
      ORDER BY period_start DESC
      LIMIT ${requestedLimit + 1};
    `;
    const { rows } = await client.query(sql, params);
    return { rows, requestedLimit };
  }

  private async readDataAsOf(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ data_as_of: Date | null }> }> },
    sourceView: string,
  ): Promise<Date | null> {
    const { rows } = await client.query(`SELECT data_as_of FROM analytics_mv.mv_lineage WHERE view_name = $1;`, [
      sourceView,
    ]);
    return rows[0]?.data_as_of ?? null;
  }
}

interface SourceRow {
  period_start: Date;
  period_end: Date;
  value: string | number | null;
}

/** Shared by `readRows` (bounded live reads) and `queryForExport` (Phase 6's larger, flat export read) - one WHERE-building implementation, never two that could drift apart. */
function appendPeriodConditions(conditions: string[], params: unknown[], filter: MetricQueryFilter): void {
  if (filter.periodStart) {
    params.push(filter.periodStart);
    conditions.push(`period_start >= $${params.length}::timestamptz`);
  }
  if (filter.periodEnd) {
    params.push(filter.periodEnd);
    conditions.push(`period_start < $${params.length}::timestamptz`);
  }
}

function appendDimensionConditions(
  conditions: string[],
  params: unknown[],
  spec: { allowedDimensions: string[] },
  filter: MetricQueryFilter,
): void {
  for (const dimensionColumn of spec.allowedDimensions) {
    const dimension = DIMENSION_COLUMNS[dimensionColumn];
    const value = filter[dimension.filterKey];
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${dimension.column} = $${params.length}::${dimension.cast}`);
    }
  }
}

function shapeResults(
  metricName: string,
  rows: SourceRow[],
  requestedLimit: number,
  dataAsOf: Date | null,
): MetricResultData[] {
  // rows[i] compares against rows[i+1] (the immediately preceding period,
  // since the query orders DESC). readRows fetched requestedLimit+1 rows
  // so the *last returned result* can have a real comparison - but only
  // drop that extra row when it actually exists. If fewer rows exist in
  // the table than requestedLimit+1, every fetched row is a real result
  // (the oldest of them just has no comparison) - a real bug this exact
  // scenario caught in verification: `Math.min` here, not an unconditional
  // `rows.length - 1`, which silently dropped the *only* row when a
  // tenant/dimension combination had just one period on file.
  const resultCount = Math.min(requestedLimit, rows.length);
  return rows.slice(0, resultCount).map((row, index) => {
    const value = row.value === null ? null : Number(row.value);
    const comparisonRow = rows[index + 1];
    const comparisonPeriodValue =
      comparisonRow?.value === null || comparisonRow?.value === undefined ? null : Number(comparisonRow.value);
    return {
      metric: metricName,
      value,
      comparisonPeriodValue,
      trend: deriveTrend(value, comparisonPeriodValue),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      dataAsOf,
    };
  });
}

function deriveTrend(value: number | null, comparisonPeriodValue: number | null): 'up' | 'down' | 'flat' | null {
  if (value === null || comparisonPeriodValue === null) {
    return null;
  }
  if (value > comparisonPeriodValue) {
    return 'up';
  }
  if (value < comparisonPeriodValue) {
    return 'down';
  }
  return 'flat';
}

function resolvePeriodBounds(period: ExecutiveSummaryPeriod): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  switch (period) {
    case ExecutiveSummaryPeriod.CURRENT_MONTH:
      return { periodStart: currentMonthStart, periodEnd: addMonthsUtc(currentMonthStart, 1) };
    case ExecutiveSummaryPeriod.LAST_MONTH:
      return { periodStart: addMonthsUtc(currentMonthStart, -1), periodEnd: currentMonthStart };
    case ExecutiveSummaryPeriod.LAST_QUARTER: {
      const currentQuarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      const currentQuarterStart = new Date(Date.UTC(now.getUTCFullYear(), currentQuarterStartMonth, 1));
      return { periodStart: addMonthsUtc(currentQuarterStart, -3), periodEnd: currentQuarterStart };
    }
  }
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}
