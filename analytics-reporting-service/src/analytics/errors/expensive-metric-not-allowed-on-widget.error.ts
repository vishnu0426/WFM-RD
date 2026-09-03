import { DomainError } from '../../common/errors/domain-error';

/**
 * §0.5/§2.3 rule 2: a metric with `estimatedCostTier = 'expensive'` may
 * back an async report, never a dashboard widget users load repeatedly.
 * None of this module's six seeded platform-default metrics are tiered
 * `'expensive'` (all are `'cheap'`, backed by pre-computed rollup tables),
 * so this cannot trigger yet in Phase 4 - it exists so `createDashboard`
 * enforces the rule from day one, ready for Phase 5's tenant-authored
 * metrics (the first ones that could actually be tiered `'expensive'`).
 */
export class ExpensiveMetricNotAllowedOnWidgetError extends DomainError {
  constructor(metricName: string) {
    super(
      'EXPENSIVE_METRIC_NOT_ALLOWED_ON_WIDGET',
      `Metric "${metricName}" is tiered "expensive" and cannot back a live dashboard widget - use the async report/export path instead.`,
    );
  }
}
