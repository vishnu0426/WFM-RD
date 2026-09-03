import { Module } from '@nestjs/common';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { migratorReplicaPoolProvider } from '../database/migrator-replica-pool.provider';
import { MetricsModule } from '../common/metrics/metrics.module';
import { MvAdherenceTrendRollupRefreshJobService } from './mv-adherence-trend-rollup-refresh-job.service';
import { MvForecastAccuracyTrendRefreshJobService } from './mv-forecast-accuracy-trend-refresh-job.service';
import { MvCostVsBudgetRefreshJobService } from './mv-cost-vs-budget-refresh-job.service';
import { MvAttritionBySiteRefreshJobService } from './mv-attrition-by-site-refresh-job.service';
import { MvFreshnessMonitorService } from './mv-freshness-monitor.service';
import { MvConsistencyCheckJobService } from './mv-consistency-check-job.service';
import { MvTenantOnboardingMilestonesRefreshJobService } from './mv-tenant-onboarding-milestones-refresh-job.service';
import { MvTenantHealthRefreshJobService } from './mv-tenant-health-refresh-job.service';

/**
 * Phase 2/3 (§8, ADR-0108): the materialized-view refresh runner. Own
 * copies of both pool providers (ADR-0039 precedent) rather than importing
 * a shared database module - this is the one place in the service that
 * holds `agno_migrator` credentials at runtime, and keeping that contained
 * to this module (not exported, not injected anywhere outside it) is
 * deliberate.
 *
 * Every job writes via `MIGRATOR_PG_POOL`, not `agno_analytics_app` -
 * Phase 1's design doc originally framed this module's own app role as
 * the writer, before implementation surfaced the same problem ADR-0098
 * already solved for Module 08: a job upserting cross-tenant rows in one
 * tick needs the RLS-owner bypass only `agno_migrator` has, since every
 * `analytics_mv.mv_*` table carries `ENABLE` (not `FORCE`) row level
 * security. `agno_analytics_app` is reserved for what it was always meant
 * for: request-scoped, single-tenant reads/writes (Phase 4's query engine,
 * `SavedReport`/`MetricDefinition`/`DashboardWidget` CRUD).
 *
 * Phase 3 adds this module's first genuinely multi-source jobs -
 * `MvCostVsBudgetRefreshJobService` (`org`/`scheduling`/`attendance_leave`,
 * three schemas in one query, ADR-0109) and
 * `MvAttritionBySiteRefreshJobService` (`org.employees` × `org.org_units`
 * via an ltree ancestor join) - both still single-pass, cross-tenant,
 * `MIGRATOR_REPLICA_PG_POOL`-sourced reads, same shape as Phase 2's.
 *
 * Phase 8 (§2.3 rule 4, ADR-0112) adds `MvConsistencyCheckJobService` - a
 * sampling check, not a fifth refresh job, so it shares these same two
 * pools rather than needing new ones.
 */
@Module({
  imports: [MetricsModule],
  providers: [
    migratorPoolProvider,
    migratorReplicaPoolProvider,
    MvAdherenceTrendRollupRefreshJobService,
    MvForecastAccuracyTrendRefreshJobService,
    MvCostVsBudgetRefreshJobService,
    MvAttritionBySiteRefreshJobService,
    MvFreshnessMonitorService,
    MvConsistencyCheckJobService,
    MvTenantOnboardingMilestonesRefreshJobService,
    MvTenantHealthRefreshJobService,
  ],
})
export class RefreshModule {}
