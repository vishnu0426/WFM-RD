import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';
import { getNumberConfig } from '../common/config/get-number-config';
import { TimezoneResolverService } from './timezone-resolver.service';

/**
 * ADR-0098/0099: `'week'`/`'month'` never re-query `intraday.adherence_event` -
 * they aggregate this module's own already-computed `'day'` rows, bucketed
 * by each employee's own resolved timezone (`period_start AT TIME ZONE
 * $3`) rather than the connecting session's timezone or a UTC assumption -
 * a `'day'` row's `period_start` is already that employee's own local
 * midnight (`AdherenceDailyRollupJobService`), so converting it back
 * through the *same* timezone round-trips to the correct local wall-clock
 * value, which `date_trunc('week'/'month', ...)` then buckets correctly.
 * `date_trunc('week', ...)` is ISO 8601 (Monday-start), not configurable
 * per tenant.
 */
const WEEK_ROLLUP_SQL = `
  INSERT INTO compliance.adherence_score
    (id, tenant_id, employee_id, period_type, period_start, period_end,
     adherent_seconds, total_scheduled_seconds, adherence_pct, major_deviation_count, computed_at)
  SELECT
    gen_random_uuid(),
    tenant_id,
    employee_id,
    'week',
    date_trunc('week', period_start AT TIME ZONE $3) AT TIME ZONE $3 AS week_start,
    (date_trunc('week', period_start AT TIME ZONE $3) + interval '7 days') AT TIME ZONE $3 AS week_end,
    FLOOR(SUM(adherent_seconds))::integer,
    FLOOR(SUM(total_scheduled_seconds))::integer,
    ROUND((100.0 * SUM(adherent_seconds) / NULLIF(SUM(total_scheduled_seconds), 0))::numeric, 2),
    SUM(major_deviation_count)::integer,
    now()
  FROM compliance.adherence_score
  WHERE period_type = 'day' AND tenant_id = $1 AND employee_id = ANY($2::uuid[])
    AND period_start >= $4 AND period_start < $5
  GROUP BY tenant_id, employee_id, date_trunc('week', period_start AT TIME ZONE $3)
  ON CONFLICT (tenant_id, employee_id, period_type, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    adherent_seconds = EXCLUDED.adherent_seconds,
    total_scheduled_seconds = EXCLUDED.total_scheduled_seconds,
    adherence_pct = EXCLUDED.adherence_pct,
    major_deviation_count = EXCLUDED.major_deviation_count,
    computed_at = EXCLUDED.computed_at;
`;

const MONTH_ROLLUP_SQL = `
  INSERT INTO compliance.adherence_score
    (id, tenant_id, employee_id, period_type, period_start, period_end,
     adherent_seconds, total_scheduled_seconds, adherence_pct, major_deviation_count, computed_at)
  SELECT
    gen_random_uuid(),
    tenant_id,
    employee_id,
    'month',
    date_trunc('month', period_start AT TIME ZONE $3) AT TIME ZONE $3 AS month_start,
    (date_trunc('month', period_start AT TIME ZONE $3) + interval '1 month') AT TIME ZONE $3 AS month_end,
    FLOOR(SUM(adherent_seconds))::integer,
    FLOOR(SUM(total_scheduled_seconds))::integer,
    ROUND((100.0 * SUM(adherent_seconds) / NULLIF(SUM(total_scheduled_seconds), 0))::numeric, 2),
    SUM(major_deviation_count)::integer,
    now()
  FROM compliance.adherence_score
  WHERE period_type = 'day' AND tenant_id = $1 AND employee_id = ANY($2::uuid[])
    AND period_start >= $4 AND period_start < $5
  GROUP BY tenant_id, employee_id, date_trunc('month', period_start AT TIME ZONE $3)
  ON CONFLICT (tenant_id, employee_id, period_type, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    adherent_seconds = EXCLUDED.adherent_seconds,
    total_scheduled_seconds = EXCLUDED.total_scheduled_seconds,
    adherence_pct = EXCLUDED.adherence_pct,
    major_deviation_count = EXCLUDED.major_deviation_count,
    computed_at = EXCLUDED.computed_at;
`;

const DISTINCT_DAY_EMPLOYEES_SQL = `
  SELECT DISTINCT tenant_id, employee_id
  FROM compliance.adherence_score
  WHERE period_type = 'day' AND period_start >= $1 AND period_start < $2;
`;

/**
 * §0.5's daily-cadence rollup SLO: once-a-day, well after the 15-minute
 * daily job has had many chances to close out yesterday's local days
 * across every timezone in play.
 */
@Injectable()
export class AdherenceWeeklyMonthlyRollupJobService {
  private readonly logger = new Logger(AdherenceWeeklyMonthlyRollupJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly timezoneResolver: TimezoneResolverService,
  ) {}

  @Cron('30 1 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    const start = process.hrtime.bigint();
    try {
      await this.rollupTrailingWindow(new Date());
      this.metrics.recordRollupJobRun('daily', 'success');
    } catch (err) {
      this.metrics.recordRollupJobRun('daily', 'error');
      this.logger.error(`Weekly/monthly rollup tick failed: ${(err as Error).message}`);
    } finally {
      this.metrics.observeRollupJobLag('daily', secondsSince(start));
      this.ticking = false;
    }
  }

  async rollupTrailingWindow(now: Date): Promise<void> {
    const trailingDays = getNumberConfig(this.config, 'ADHERENCE_WEEKLY_MONTHLY_ROLLUP_TRAILING_DAYS', 35);
    const rawWindowStart = new Date(now.getTime() - trailingDays * 24 * 60 * 60 * 1000);
    // Same boundary-safety reasoning as the pre-ADR-0099 version (round
    // back to the Monday on-or-before the containing month's own start,
    // so a week/month is never aggregated from only some of its
    // constituent days) - now with one extra day of margin, since
    // `AT TIME ZONE` bucketing means the *effective* boundary for an
    // extreme-offset timezone (up to UTC-12/UTC+14) can differ from this
    // UTC-computed cutoff by nearly a full day. Any residual edge case
    // self-heals on the next daily tick (this window is always "the most
    // recent N days," never "since last successful run"), so this is a
    // safety margin, not a load-bearing exactness guarantee.
    const monthStart = new Date(Date.UTC(rawWindowStart.getUTCFullYear(), rawWindowStart.getUTCMonth(), 1));
    const isoDayOfWeek = monthStart.getUTCDay() === 0 ? 7 : monthStart.getUTCDay();
    const windowStart = new Date(monthStart.getTime() - isoDayOfWeek * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const { rows } = await this.pool.query<{ tenant_id: string; employee_id: string }>(DISTINCT_DAY_EMPLOYEES_SQL, [
      windowStart,
      windowEnd,
    ]);
    const employeeIdsByTenant = new Map<string, string[]>();
    for (const row of rows) {
      const list = employeeIdsByTenant.get(row.tenant_id) ?? [];
      list.push(row.employee_id);
      employeeIdsByTenant.set(row.tenant_id, list);
    }

    for (const [tenantId, employeeIds] of employeeIdsByTenant) {
      const timezoneByEmployee = await this.timezoneResolver.resolveTimezones(tenantId, employeeIds);
      const employeeIdsByTimezone = new Map<string, string[]>();
      for (const [employeeId, timezone] of timezoneByEmployee) {
        const list = employeeIdsByTimezone.get(timezone) ?? [];
        list.push(employeeId);
        employeeIdsByTimezone.set(timezone, list);
      }

      for (const [timezone, groupEmployeeIds] of employeeIdsByTimezone) {
        const params = [tenantId, groupEmployeeIds, timezone, windowStart, windowEnd];
        await this.pool.query(WEEK_ROLLUP_SQL, params);
        await this.pool.query(MONTH_ROLLUP_SQL, params);
      }
    }
  }
}

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
