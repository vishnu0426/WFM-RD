import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_adherence_trend_rollup';

// Re-aggregates every (tenant_id, period_type, period_start, period_end)
// triple Module 08's own rollup already computed - this query never
// derives a period boundary itself, it only groups across employees
// within one Module 08 already decided (this migration's own doc comment
// explains why: adherence_score carries no org_unit_id, so this is a
// tenant-level trend, not an org-unit breakdown).
// max(computed_at) per group backs data_as_of below - NOT max(period_end).
// A week/month period_end is a nominal calendar boundary Module 08 assigns
// up front (e.g. a month's last calendar day) and can be later than "now"
// for a period still in progress; computed_at is the real wall-clock
// instant Module 08 actually wrote that row, which can never be in the
// future. Using period_end here originally tripped this table's own
// mv_lineage_data_as_of_not_after_refresh_check in real verification
// against real week/month test rows - caught before shipping, not a
// hypothetical.
const SOURCE_QUERY = `
  SELECT tenant_id, period_type, period_start, period_end,
         avg(adherence_pct) AS avg_adherence_pct,
         sum(major_deviation_count) AS total_major_deviation_count,
         count(DISTINCT employee_id) AS employee_count,
         max(computed_at) AS max_computed_at
  FROM compliance.adherence_score
  GROUP BY tenant_id, period_type, period_start, period_end;
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_adherence_trend_rollup
    (id, tenant_id, period_type, period_start, period_end, avg_adherence_pct,
     total_major_deviation_count, employee_count, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now())
  ON CONFLICT (tenant_id, period_type, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    avg_adherence_pct = EXCLUDED.avg_adherence_pct,
    total_major_deviation_count = EXCLUDED.total_major_deviation_count,
    employee_count = EXCLUDED.employee_count,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  period_type: string;
  period_start: Date;
  period_end: Date;
  avg_adherence_pct: string;
  total_major_deviation_count: string;
  employee_count: string;
  max_computed_at: Date;
}

/**
 * Phase 2 (§8 Phase 2, ADR-0108): this service's first `@Cron` job. Reads
 * `compliance.adherence_score` via `MIGRATOR_REPLICA_PG_POOL` (the analytics
 * replica, load-isolated from every owning module's primary) and upserts
 * into `analytics_mv.mv_adherence_trend_rollup` via `MIGRATOR_PG_POOL` (the
 * primary - replicas reject writes). Both pools are `agno_migrator`,
 * bypassing RLS on both ends for the identical reason Module 08's own
 * `MIGRATOR_PG_POOL`-based rollup jobs do (ADR-0098): this tick touches
 * every tenant's rows in one pass.
 *
 * "Idempotent and resumable" (§2.2 rule 4): `ON CONFLICT ... DO UPDATE`
 * converges a re-run on the identical result, never a duplicate row - a
 * crashed prior tick or the next scheduled tick simply re-derives the same
 * numbers from the same source data.
 *
 * `mv_lineage.refreshed_at`/`data_as_of`/`last_run_status` are updated in
 * the same transaction as the upserts (via `MIGRATOR_PG_POOL`) - `data_as_of`
 * is the max `adherence_score.computed_at` actually observed in the source
 * data this tick, not `now()` and not `period_end` (a nominal calendar
 * boundary that can be later than "now" for a week/month period still in
 * progress - a real constraint violation this job hit in verification
 * before this fix): the freshness a caller should trust is "as of the
 * latest moment Module 08 actually computed a row," which can lag
 * wall-clock time by however far behind Module 08's own rollup jobs are
 * running.
 *
 * `analytics_mv_refresh_lag_seconds` (§0.5's staleness SLO) is deliberately
 * *not* set here - a value only updated when a tick succeeds would read
 * "fresh" forever if this job stopped running entirely, exactly the
 * silent-staleness failure mode §0.5 exists to catch. `MvFreshnessMonitorService`
 * samples `mv_lineage.refreshed_at` independently, on its own schedule, so
 * the gauge keeps moving even if this job never ticks again.
 */
@Injectable()
export class MvAdherenceTrendRollupRefreshJobService {
  private readonly logger = new Logger(MvAdherenceTrendRollupRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('0 2 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.refresh();
      this.metrics.mvRefreshJobRunsTotal.inc({ view_name: VIEW_NAME, result: 'completed' });
    } catch (err) {
      this.metrics.mvRefreshJobRunsTotal.inc({ view_name: VIEW_NAME, result: 'failed' });
      this.logger.error(`${VIEW_NAME} refresh failed: ${(err as Error).message}`);
      await this.markFailed();
    } finally {
      this.ticking = false;
    }
  }

  async refresh(): Promise<void> {
    const { rows } = await this.replicaPool.query<SourceRow>(SOURCE_QUERY);

    const client = await this.primaryPool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(UPSERT_SQL, [
          row.tenant_id,
          row.period_type,
          row.period_start,
          row.period_end,
          row.avg_adherence_pct,
          row.total_major_deviation_count,
          row.employee_count,
        ]);
      }
      const dataAsOf = rows.length > 0 ? maxComputedAt(rows) : null;
      await client.query(
        `
        UPDATE analytics_mv.mv_lineage
        SET refreshed_at = now(), data_as_of = COALESCE($1, data_as_of), last_run_status = 'success'
        WHERE view_name = $2;
        `,
        [dataAsOf, VIEW_NAME],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async markFailed(): Promise<void> {
    await this.primaryPool.query(
      `UPDATE analytics_mv.mv_lineage SET last_run_status = 'failed' WHERE view_name = $1;`,
      [VIEW_NAME],
    );
  }
}

function maxComputedAt(rows: SourceRow[]): Date {
  return rows.reduce((max, row) => (row.max_computed_at > max ? row.max_computed_at : max), rows[0].max_computed_at);
}
