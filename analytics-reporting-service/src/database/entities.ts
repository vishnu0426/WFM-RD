import { SavedReport } from '../analytics/entities/saved-report.entity';
import { MetricDefinition } from '../analytics/entities/metric-definition.entity';
import { DashboardWidget } from '../analytics/entities/dashboard-widget.entity';
import { MvLineage } from '../analytics/entities/mv-lineage.entity';
import { MvAdherenceTrendRollup } from '../analytics/entities/mv-adherence-trend-rollup.entity';
import { MvForecastAccuracyTrend } from '../analytics/entities/mv-forecast-accuracy-trend.entity';
import { MvCostVsBudget } from '../analytics/entities/mv-cost-vs-budget.entity';
import { MvAttritionBySite } from '../analytics/entities/mv-attrition-by-site.entity';
import { AnalyticsExport } from '../analytics/entities/analytics-export.entity';
import { ScorecardSourceSystem } from '../scorecards/entities/scorecard-source-system.entity';
import { ScorecardSourceMeasure } from '../scorecards/entities/scorecard-source-measure.entity';
import { ScorecardSourceCode } from '../scorecards/entities/scorecard-source-code.entity';
import { ScorecardSourceMapping } from '../scorecards/entities/scorecard-source-mapping.entity';
import { ScorecardDimensionType } from '../scorecards/entities/scorecard-dimension-type.entity';
import { ScorecardDimensionMember } from '../scorecards/entities/scorecard-dimension-member.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's own
 * `src/database/entities.ts` in this platform. Six `Scorecard*` entities
 * added by Tenant Admin Integration Management WP6.
 */
export const entities = [
  SavedReport,
  MetricDefinition,
  DashboardWidget,
  MvLineage,
  MvAdherenceTrendRollup,
  MvForecastAccuracyTrend,
  MvCostVsBudget,
  MvAttritionBySite,
  AnalyticsExport,
  ScorecardSourceSystem,
  ScorecardSourceMeasure,
  ScorecardSourceCode,
  ScorecardSourceMapping,
  ScorecardDimensionType,
  ScorecardDimensionMember,
];

export {
  SavedReport,
  MetricDefinition,
  DashboardWidget,
  MvLineage,
  MvAdherenceTrendRollup,
  MvForecastAccuracyTrend,
  MvCostVsBudget,
  MvAttritionBySite,
  AnalyticsExport,
  ScorecardSourceSystem,
  ScorecardSourceMeasure,
  ScorecardSourceCode,
  ScorecardSourceMapping,
  ScorecardDimensionType,
  ScorecardDimensionMember,
};
