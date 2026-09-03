import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { SavedReportType } from '../../src/analytics/entities/saved-report.entity';
import { MetricCategory, MetricCostTier } from '../../src/analytics/entities/metric-definition.entity';
import { MvRefreshCadence, MvLastRunStatus } from '../../src/analytics/entities/mv-lineage.entity';
import { MvAdherenceTrendRollupPeriodType } from '../../src/analytics/entities/mv-adherence-trend-rollup.entity';
import { AnalyticsExportStatus } from '../../src/analytics/entities/analytics-export.entity';
import { entities } from '../../src/database/entities';

/**
 * Verifies the TypeORM entity classes agree with the §2.1/§2.2 DDL and the
 * ADR-0003 enum-representation convention (a real TS enum backs every
 * varchar+CHECK column) - catches an entity/migration drift that a
 * TypeScript compile alone would not.
 */
describe('database entities', () => {
  it('registers all nine entities as of Phase 6, six scoped to analytics_mv', () => {
    expect(entities).toHaveLength(9);
    const entitySet = new Set<unknown>(entities);
    const tables = getMetadataArgsStorage().tables.filter((t) => entitySet.has(t.target));
    expect(tables).toHaveLength(9);
    const byName = new Map(tables.map((t) => [t.name, t.schema]));
    expect(byName.get('saved_report')).toBe('analytics');
    expect(byName.get('metric_definition')).toBe('analytics');
    expect(byName.get('dashboard_widget')).toBe('analytics');
    expect(byName.get('analytics_export')).toBe('analytics');
    expect(byName.get('mv_lineage')).toBe('analytics_mv');
    expect(byName.get('mv_adherence_trend_rollup')).toBe('analytics_mv');
    expect(byName.get('mv_forecast_accuracy_trend')).toBe('analytics_mv');
    expect(byName.get('mv_cost_vs_budget')).toBe('analytics_mv');
    expect(byName.get('mv_attrition_by_site')).toBe('analytics_mv');
  });

  it('AnalyticsExportStatus matches pending/completed/failed exactly', () => {
    expect(Object.values(AnalyticsExportStatus).sort()).toEqual(['pending', 'completed', 'failed'].sort());
  });

  it("MvAdherenceTrendRollupPeriodType matches adherence_score's own period_type enum exactly", () => {
    expect(Object.values(MvAdherenceTrendRollupPeriodType).sort()).toEqual(['shift', 'day', 'week', 'month'].sort());
  });

  it("SavedReportType matches §2.1's enum exactly", () => {
    expect(Object.values(SavedReportType).sort()).toEqual(['dashboard', 'scheduled_export', 'ad_hoc'].sort());
  });

  it("MetricCategory matches §2.1's enum exactly", () => {
    expect(Object.values(MetricCategory).sort()).toEqual(
      ['attendance', 'occupancy', 'cost', 'performance', 'forecast_accuracy'].sort(),
    );
  });

  it('MetricCostTier matches §2.1/§0.5 cheap/moderate/expensive exactly', () => {
    expect(Object.values(MetricCostTier).sort()).toEqual(['cheap', 'moderate', 'expensive'].sort());
  });

  it('MvRefreshCadence matches §3 hourly/daily exactly', () => {
    expect(Object.values(MvRefreshCadence).sort()).toEqual(['hourly', 'daily'].sort());
  });

  it('MvLastRunStatus matches success/failed exactly', () => {
    expect(Object.values(MvLastRunStatus).sort()).toEqual(['success', 'failed'].sort());
  });
});
