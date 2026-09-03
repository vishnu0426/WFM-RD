/**
 * The whitelist `MetricQueryEngineService` validates every
 * `MetricDefinition.calculationDefinition` against before building any SQL
 * - `sourceView`/`valueColumn`/a dimension column name are never
 * interpolated into a query string without first matching an entry here.
 * This is the security boundary Phase 5's tenant-authored dry-run
 * validation gate will also need for arbitrary tenant-supplied
 * `calculation_definition` jsonb - built once now, for this phase's own
 * platform-default metrics, rather than deferred and then rebuilt.
 *
 * `table` is the fully-qualified `analytics_mv.*` relation name (never
 * derived from user input - `sourceView` is the registry *key*, looked up
 * then discarded; the SQL always uses this file's own `table` string).
 */
export interface SourceViewSpec {
  table: string;
  allowedValueColumns: string[];
  /** Columns a filter may narrow on in addition to tenant_id/period bounds. */
  allowedDimensions: string[];
}

export const SOURCE_VIEW_REGISTRY: Record<string, SourceViewSpec> = {
  mv_adherence_trend_rollup: {
    table: 'analytics_mv.mv_adherence_trend_rollup',
    allowedValueColumns: ['avg_adherence_pct', 'total_major_deviation_count', 'employee_count'],
    allowedDimensions: ['period_type'],
  },
  mv_forecast_accuracy_trend: {
    table: 'analytics_mv.mv_forecast_accuracy_trend',
    allowedValueColumns: ['avg_mape', 'avg_bias', 'forecast_count'],
    allowedDimensions: ['org_unit_id'],
  },
  mv_cost_vs_budget: {
    table: 'analytics_mv.mv_cost_vs_budget',
    allowedValueColumns: ['scheduled_hours', 'overtime_hours', 'approved_leave_days'],
    allowedDimensions: ['cost_center'],
  },
  mv_attrition_by_site: {
    table: 'analytics_mv.mv_attrition_by_site',
    allowedValueColumns: ['terminations_count'],
    allowedDimensions: ['site_org_unit_id'],
  },
};
