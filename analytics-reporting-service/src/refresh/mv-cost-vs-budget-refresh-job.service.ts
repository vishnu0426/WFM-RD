import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';

const VIEW_NAME = 'mv_cost_vs_budget';

// Two independent monthly aggregates (scheduled/overtime hours from
// shift_assignments, approved leave days from leave_request), combined
// with a FULL OUTER JOIN so a (tenant, cost_center, month) with leave but
// no shifts - or shifts but no leave - still produces one correct row
// rather than being silently dropped by an INNER JOIN. employees with no
// cost_center are excluded on both sides (ADR-0109: not attributed to a
// fabricated bucket). max_observed_at is the real timestamp each source
// row was actually written/decided - never a nominal period boundary,
// the same class of bug Phase 2's adherence job hit and fixed.
const SOURCE_QUERY = `
  WITH scheduled AS (
    SELECT e.tenant_id, e.cost_center,
           date_trunc('month', sa.shift_start) AS period_start,
           sum(EXTRACT(EPOCH FROM (sa.shift_end - sa.shift_start)) / 3600.0) AS scheduled_hours,
           sum(CASE WHEN sa.is_overtime
                 THEN EXTRACT(EPOCH FROM (sa.shift_end - sa.shift_start)) / 3600.0
                 ELSE 0 END) AS overtime_hours,
           max(sa.updated_at) AS max_observed_at
    FROM scheduling.shift_assignments sa
    JOIN org.employees e ON e.tenant_id = sa.tenant_id AND e.id = sa.employee_id
    WHERE e.cost_center IS NOT NULL
    GROUP BY e.tenant_id, e.cost_center, date_trunc('month', sa.shift_start)
  ),
  leave_days AS (
    -- Calendar days (date_range_end - date_range_start + 1), not
    -- working-day-aware; a request spanning a month boundary is
    -- attributed wholly to its start month. Disclosed simplifications
    -- (ADR-0109), not precision this data supports.
    SELECT e.tenant_id, e.cost_center,
           date_trunc('month', lr.date_range_start::timestamptz) AS period_start,
           sum(lr.date_range_end - lr.date_range_start + 1) AS approved_leave_days,
           max(lr.decided_at) AS max_observed_at
    FROM attendance_leave.leave_request lr
    JOIN org.employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
    WHERE lr.status = 'approved' AND e.cost_center IS NOT NULL
    GROUP BY e.tenant_id, e.cost_center, date_trunc('month', lr.date_range_start::timestamptz)
  )
  SELECT
    coalesce(s.tenant_id, l.tenant_id) AS tenant_id,
    coalesce(s.cost_center, l.cost_center) AS cost_center,
    coalesce(s.period_start, l.period_start) AS period_start,
    coalesce(s.scheduled_hours, 0) AS scheduled_hours,
    coalesce(s.overtime_hours, 0) AS overtime_hours,
    coalesce(l.approved_leave_days, 0) AS approved_leave_days,
    greatest(coalesce(s.max_observed_at, '-infinity'::timestamptz),
             coalesce(l.max_observed_at, '-infinity'::timestamptz)) AS max_observed_at
  FROM scheduled s
  FULL OUTER JOIN leave_days l
    ON s.tenant_id = l.tenant_id AND s.cost_center = l.cost_center AND s.period_start = l.period_start;
`;

const UPSERT_SQL = `
  INSERT INTO analytics_mv.mv_cost_vs_budget
    (id, tenant_id, cost_center, period_start, period_end, scheduled_hours, overtime_hours, approved_leave_days, computed_at)
  VALUES (gen_random_uuid(), $1, $2, $3::timestamptz, $3::timestamptz + interval '1 month', $4, $5, $6, now())
  ON CONFLICT (tenant_id, cost_center, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    scheduled_hours = EXCLUDED.scheduled_hours,
    overtime_hours = EXCLUDED.overtime_hours,
    approved_leave_days = EXCLUDED.approved_leave_days,
    computed_at = now();
`;

interface SourceRow {
  tenant_id: string;
  cost_center: string;
  period_start: Date;
  scheduled_hours: string;
  overtime_hours: string;
  approved_leave_days: string;
  max_observed_at: Date;
}

/**
 * Phase 3 (§8 Phase 3, ADR-0108/ADR-0109): this module's first genuinely
 * multi-source refresh job - `org.employees.cost_center` × `scheduling.
 * shift_assignments` × `attendance_leave.leave_request`, all three read in
 * one query via `MIGRATOR_REPLICA_PG_POOL`. Same two-pool, `agno_migrator`-
 * on-both-ends shape as Phase 2's jobs, for the identical RLS-owner-bypass
 * reason (ADR-0098) - now spanning three schemas' RLS instead of one.
 *
 * Despite the table's name, this writes **hours and days, never a dollar
 * figure** - see ADR-0109 for why (no pay-rate/budget capability exists
 * anywhere in this platform).
 */
@Injectable()
export class MvCostVsBudgetRefreshJobService {
  private readonly logger = new Logger(MvCostVsBudgetRefreshJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('0 3 * * *')
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
          row.cost_center,
          row.period_start,
          row.scheduled_hours,
          row.overtime_hours,
          row.approved_leave_days,
        ]);
      }
      const dataAsOf = rows.length > 0 ? maxObservedAt(rows) : null;
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

function maxObservedAt(rows: SourceRow[]): Date {
  return rows.reduce((max, row) => (row.max_observed_at > max ? row.max_observed_at : max), rows[0].max_observed_at);
}
