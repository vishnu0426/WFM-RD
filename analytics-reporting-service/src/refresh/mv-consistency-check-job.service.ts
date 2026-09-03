import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * §2.3 rule 4/on-call: "a materialized view's aggregate disagreeing with a
 * fresh read of its source tables is an alerting condition, not a silent
 * discrepancy" (`MetricsService.consistencyCheckDiscrepanciesTotal`'s own
 * doc comment, declared in Phase 1, wired here in Phase 8).
 *
 * This is a **sample**, not an exhaustive recompute - the metric's own help
 * text says so (`consistency_check_discrepancies_total`'s help: "...where a
 * materialized view *sample* disagreed..."). Re-deriving every row of every
 * view on every tick would mean running the full refresh job's own
 * aggregate query a second time for no reason beyond this check - the
 * refresh job already does that daily. Sampling `SAMPLE_SIZE` already-
 * upserted rows per view per tick, and re-deriving only *that exact group's*
 * aggregate from source, is the same one-group-at-a-time cost this
 * service's own `query()` read path already pays per call, just run
 * unattended on a schedule instead of per-request.
 *
 * A real discrepancy here is expected sometimes, not automatically a bug:
 * `data_as_of` documents that an MV's numbers lag source data by however
 * long since its last refresh tick, so a fresh recompute run between ticks
 * can legitimately disagree with a not-yet-refreshed MV row (new source
 * rows landed since). `TOLERANCE` exists to absorb that normal drift;
 * exceeding it is the actual alerting condition - either the gap has grown
 * large enough to be worth a human look, or the refresh/aggregation logic
 * itself has a real bug. This job cannot tell those two apart on its own;
 * it only surfaces the disagreement (`view_name`, the sampled group's own
 * keys, both values) for a human to triage, same posture as every other
 * `Logger.error` in this module's own refresh jobs.
 */
const SAMPLE_SIZE = 20;
const RELATIVE_TOLERANCE = 0.05;
const ABSOLUTE_TOLERANCE = 0.5;

function disagrees(mvValue: number, freshValue: number): boolean {
  const diff = Math.abs(mvValue - freshValue);
  const threshold = Math.max(ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE * Math.abs(freshValue));
  return diff > threshold;
}

interface AdherenceTrendRow {
  tenant_id: string;
  period_type: string;
  period_start: Date;
  period_end: Date;
  avg_adherence_pct: string;
  total_major_deviation_count: string;
  employee_count: string;
}

interface ForecastAccuracyRow {
  tenant_id: string;
  org_unit_id: string;
  period_start: Date;
  avg_mape: string | null;
  avg_bias: string | null;
  forecast_count: string;
}

interface CostVsBudgetRow {
  tenant_id: string;
  cost_center: string;
  period_start: Date;
  scheduled_hours: string;
  overtime_hours: string;
  approved_leave_days: string;
}

interface AttritionBySiteRow {
  tenant_id: string;
  site_org_unit_id: string;
  period_start: Date;
  terminations_count: string;
}

@Injectable()
export class MvConsistencyCheckJobService {
  private readonly logger = new Logger(MvConsistencyCheckJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('0 4 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await Promise.all([
        this.checkAdherenceTrendRollup(),
        this.checkForecastAccuracyTrend(),
        this.checkCostVsBudget(),
        this.checkAttritionBySite(),
      ]);
    } finally {
      this.ticking = false;
    }
  }

  async checkAdherenceTrendRollup(): Promise<void> {
    const viewName = 'mv_adherence_trend_rollup';
    try {
      const { rows: sampled } = await this.primaryPool.query<AdherenceTrendRow>(
        `SELECT tenant_id, period_type, period_start, period_end, avg_adherence_pct,
                total_major_deviation_count, employee_count
         FROM analytics_mv.mv_adherence_trend_rollup ORDER BY random() LIMIT $1;`,
        [SAMPLE_SIZE],
      );
      for (const row of sampled) {
        const { rows: freshRows } = await this.replicaPool.query<{
          avg_adherence_pct: string | null;
          total_major_deviation_count: string;
          employee_count: string;
        }>(
          `SELECT avg(adherence_pct) AS avg_adherence_pct,
                  sum(major_deviation_count) AS total_major_deviation_count,
                  count(DISTINCT employee_id) AS employee_count
           FROM compliance.adherence_score
           WHERE tenant_id = $1 AND period_type = $2 AND period_start = $3 AND period_end = $4;`,
          [row.tenant_id, row.period_type, row.period_start, row.period_end],
        );
        const fresh = freshRows[0];
        const mismatched =
          disagrees(Number(row.avg_adherence_pct), Number(fresh.avg_adherence_pct ?? 0)) ||
          disagrees(Number(row.total_major_deviation_count), Number(fresh.total_major_deviation_count ?? 0)) ||
          disagrees(Number(row.employee_count), Number(fresh.employee_count ?? 0));
        if (mismatched) {
          this.metrics.consistencyCheckDiscrepanciesTotal.inc({ view_name: viewName });
          this.logger.error(
            `${viewName} discrepancy: tenant=${row.tenant_id} period_type=${row.period_type} period_start=${row.period_start.toISOString()} ` +
              `mv=[${row.avg_adherence_pct},${row.total_major_deviation_count},${row.employee_count}] fresh=[${fresh.avg_adherence_pct},${fresh.total_major_deviation_count},${fresh.employee_count}]`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`${viewName} consistency check failed: ${(err as Error).message}`);
    }
  }

  async checkForecastAccuracyTrend(): Promise<void> {
    const viewName = 'mv_forecast_accuracy_trend';
    try {
      const { rows: sampled } = await this.primaryPool.query<ForecastAccuracyRow>(
        `SELECT tenant_id, org_unit_id, period_start, avg_mape, avg_bias, forecast_count
         FROM analytics_mv.mv_forecast_accuracy_trend ORDER BY random() LIMIT $1;`,
        [SAMPLE_SIZE],
      );
      for (const row of sampled) {
        const { rows: freshRows } = await this.replicaPool.query<{
          avg_mape: string | null;
          avg_bias: string | null;
          forecast_count: string;
        }>(
          `SELECT avg(mape) AS avg_mape, avg(bias) AS avg_bias, count(*) AS forecast_count
           FROM forecasting.forecast_accuracy_log
           WHERE mape IS NOT NULL AND tenant_id = $1 AND org_unit_id = $2
             AND date_trunc('day', evaluated_at) = $3;`,
          [row.tenant_id, row.org_unit_id, row.period_start],
        );
        const fresh = freshRows[0];
        const mismatched =
          disagrees(Number(row.avg_mape ?? 0), Number(fresh.avg_mape ?? 0)) ||
          disagrees(Number(row.avg_bias ?? 0), Number(fresh.avg_bias ?? 0)) ||
          disagrees(Number(row.forecast_count), Number(fresh.forecast_count ?? 0));
        if (mismatched) {
          this.metrics.consistencyCheckDiscrepanciesTotal.inc({ view_name: viewName });
          this.logger.error(
            `${viewName} discrepancy: tenant=${row.tenant_id} org_unit=${row.org_unit_id} period_start=${row.period_start.toISOString()} ` +
              `mv=[${row.avg_mape},${row.avg_bias},${row.forecast_count}] fresh=[${fresh.avg_mape},${fresh.avg_bias},${fresh.forecast_count}]`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`${viewName} consistency check failed: ${(err as Error).message}`);
    }
  }

  async checkCostVsBudget(): Promise<void> {
    const viewName = 'mv_cost_vs_budget';
    try {
      const { rows: sampled } = await this.primaryPool.query<CostVsBudgetRow>(
        `SELECT tenant_id, cost_center, period_start, scheduled_hours, overtime_hours, approved_leave_days
         FROM analytics_mv.mv_cost_vs_budget ORDER BY random() LIMIT $1;`,
        [SAMPLE_SIZE],
      );
      for (const row of sampled) {
        const { rows: freshRows } = await this.replicaPool.query<{
          scheduled_hours: string;
          overtime_hours: string;
          approved_leave_days: string;
        }>(
          `SELECT
             coalesce((SELECT sum(EXTRACT(EPOCH FROM (sa.shift_end - sa.shift_start)) / 3600.0)
                       FROM scheduling.shift_assignments sa
                       JOIN org.employees e ON e.tenant_id = sa.tenant_id AND e.id = sa.employee_id
                       WHERE e.tenant_id = $1 AND e.cost_center = $2
                         AND date_trunc('month', sa.shift_start) = $3), 0) AS scheduled_hours,
             coalesce((SELECT sum(CASE WHEN sa.is_overtime
                         THEN EXTRACT(EPOCH FROM (sa.shift_end - sa.shift_start)) / 3600.0 ELSE 0 END)
                       FROM scheduling.shift_assignments sa
                       JOIN org.employees e ON e.tenant_id = sa.tenant_id AND e.id = sa.employee_id
                       WHERE e.tenant_id = $1 AND e.cost_center = $2
                         AND date_trunc('month', sa.shift_start) = $3), 0) AS overtime_hours,
             coalesce((SELECT sum(lr.date_range_end - lr.date_range_start + 1)
                       FROM attendance_leave.leave_request lr
                       JOIN org.employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
                       WHERE lr.status = 'approved' AND e.tenant_id = $1 AND e.cost_center = $2
                         AND date_trunc('month', lr.date_range_start::timestamptz) = $3), 0) AS approved_leave_days;`,
          [row.tenant_id, row.cost_center, row.period_start],
        );
        const fresh = freshRows[0];
        const mismatched =
          disagrees(Number(row.scheduled_hours), Number(fresh.scheduled_hours)) ||
          disagrees(Number(row.overtime_hours), Number(fresh.overtime_hours)) ||
          disagrees(Number(row.approved_leave_days), Number(fresh.approved_leave_days));
        if (mismatched) {
          this.metrics.consistencyCheckDiscrepanciesTotal.inc({ view_name: viewName });
          this.logger.error(
            `${viewName} discrepancy: tenant=${row.tenant_id} cost_center=${row.cost_center} period_start=${row.period_start.toISOString()} ` +
              `mv=[${row.scheduled_hours},${row.overtime_hours},${row.approved_leave_days}] fresh=[${fresh.scheduled_hours},${fresh.overtime_hours},${fresh.approved_leave_days}]`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`${viewName} consistency check failed: ${(err as Error).message}`);
    }
  }

  async checkAttritionBySite(): Promise<void> {
    const viewName = 'mv_attrition_by_site';
    try {
      const { rows: sampled } = await this.primaryPool.query<AttritionBySiteRow>(
        `SELECT tenant_id, site_org_unit_id, period_start, terminations_count
         FROM analytics_mv.mv_attrition_by_site ORDER BY random() LIMIT $1;`,
        [SAMPLE_SIZE],
      );
      for (const row of sampled) {
        const { rows: freshRows } = await this.replicaPool.query<{ terminations_count: string }>(
          `SELECT count(*) AS terminations_count
           FROM org.employees e
           JOIN org.org_units eu ON eu.tenant_id = e.tenant_id AND eu.id = e.org_unit_id
           JOIN org.org_units site ON site.tenant_id = e.tenant_id AND site.type = 'site' AND eu.path <@ site.path
           WHERE e.termination_date IS NOT NULL AND e.tenant_id = $1 AND site.id = $2
             AND date_trunc('month', e.termination_date::timestamptz) = $3;`,
          [row.tenant_id, row.site_org_unit_id, row.period_start],
        );
        const fresh = freshRows[0];
        const mismatched = disagrees(Number(row.terminations_count), Number(fresh.terminations_count));
        if (mismatched) {
          this.metrics.consistencyCheckDiscrepanciesTotal.inc({ view_name: viewName });
          this.logger.error(
            `${viewName} discrepancy: tenant=${row.tenant_id} site=${row.site_org_unit_id} period_start=${row.period_start.toISOString()} ` +
              `mv=${row.terminations_count} fresh=${fresh.terminations_count}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`${viewName} consistency check failed: ${(err as Error).message}`);
    }
  }
}
