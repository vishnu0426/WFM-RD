import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';
import { getNumberConfig } from '../common/config/get-number-config';
import { TimezoneResolverService } from './timezone-resolver.service';

/**
 * §0.5/ADR-0098/ADR-0099: `LEAD()` attributes the duration between two
 * consecutive `adherence_event` rows for the same employee to the
 * *earlier* row's own `scheduled_activity` - adherent iff `'on_shift'`
 * (ADR-0067's own definition, unchanged). `local_day` (ADR-0099) is
 * computed via Postgres's own `AT TIME ZONE` - `"timestamp" AT TIME ZONE
 * $3` converts the absolute instant to that employee's *actual* IANA
 * timezone's wall-clock time (DST-correct, using Postgres's own tzdata,
 * not hand-rolled offset math), then `date_trunc('day', ...)` buckets it.
 * A segment is attributed to the local day containing its *starting*
 * event, and closed off at that local day's own boundary if the next
 * event falls on a later local day - each local day is accounted
 * independently, never carrying a partial segment across a local-midnight
 * boundary. `period_start`/`period_end` are `local_day`/`local_day + 1
 * day` converted back to real `timestamptz` instants via the same `AT TIME
 * ZONE` operator - the round-trip Postgres's own tzdata guarantees is
 * correct across a DST transition, which this service does not attempt to
 * reason about by hand.
 *
 * One call covers every local day in the scan window for one (tenant,
 * timezone) group at once (`GROUP BY ... local_day`) - no per-day loop
 * needed, unlike this file's pre-ADR-0099 UTC-only version.
 *
 * GAP-11 (enterprise readiness audit, 2026-08-18): this service's own
 * `AdherenceScore.adherencePct` (duration-weighted: `adherent_seconds /
 * total_scheduled_seconds`) is the one authoritative adherence percentage
 * on this platform. intraday-service's `adherence_hourly_rollup`/
 * `adherence_daily_rollup` read the same underlying `intraday.adherence_event`
 * rows but aggregate as event *counts*, not duration - a percentage
 * derived from those tables will not agree with this one. See
 * `AdherenceRollupSchedulerService`'s own doc comment in that service.
 */
const DAILY_ROLLUP_SQL = `
  WITH events AS (
    SELECT
      tenant_id,
      employee_id,
      "timestamp",
      scheduled_activity,
      LEAD("timestamp") OVER (PARTITION BY tenant_id, employee_id ORDER BY "timestamp") AS next_timestamp,
      date_trunc('day', "timestamp" AT TIME ZONE $3) AS local_day
    FROM intraday.adherence_event
    WHERE tenant_id = $1
      AND employee_id = ANY($2::uuid[])
      AND "timestamp" >= $4 AND "timestamp" < $5
  ),
  segments AS (
    SELECT
      tenant_id,
      employee_id,
      local_day,
      GREATEST(
        EXTRACT(EPOCH FROM (
          LEAST(COALESCE(next_timestamp, (local_day + interval '1 day') AT TIME ZONE $3), (local_day + interval '1 day') AT TIME ZONE $3)
          - "timestamp"
        )),
        0
      ) AS segment_seconds,
      (scheduled_activity IS NOT DISTINCT FROM 'on_shift') AS is_adherent
    FROM events
  )
  INSERT INTO compliance.adherence_score
    (id, tenant_id, employee_id, period_type, period_start, period_end,
     adherent_seconds, total_scheduled_seconds, adherence_pct, major_deviation_count, computed_at)
  SELECT
    gen_random_uuid(),
    tenant_id,
    employee_id,
    'day',
    local_day AT TIME ZONE $3,
    (local_day + interval '1 day') AT TIME ZONE $3,
    FLOOR(COALESCE(SUM(segment_seconds) FILTER (WHERE is_adherent), 0))::integer AS adherent_seconds,
    FLOOR(SUM(segment_seconds))::integer AS total_scheduled_seconds,
    ROUND((100.0 * COALESCE(SUM(segment_seconds) FILTER (WHERE is_adherent), 0) / NULLIF(SUM(segment_seconds), 0))::numeric, 2) AS adherence_pct,
    COUNT(*) FILTER (WHERE NOT is_adherent AND segment_seconds >= $6) AS major_deviation_count,
    now()
  FROM segments
  GROUP BY tenant_id, employee_id, local_day
  ON CONFLICT (tenant_id, employee_id, period_type, period_start) DO UPDATE SET
    period_end = EXCLUDED.period_end,
    adherent_seconds = EXCLUDED.adherent_seconds,
    total_scheduled_seconds = EXCLUDED.total_scheduled_seconds,
    adherence_pct = EXCLUDED.adherence_pct,
    major_deviation_count = EXCLUDED.major_deviation_count,
    computed_at = EXCLUDED.computed_at;
`;

const DISTINCT_ACTIVE_EMPLOYEES_SQL = `
  SELECT DISTINCT tenant_id, employee_id
  FROM intraday.adherence_event
  WHERE "timestamp" >= $1 AND "timestamp" < $2;
`;

/**
 * §7 Phase 3/ADR-0098/ADR-0099: this module's first `@Cron` job. Reads
 * `intraday.adherence_event` directly via `MIGRATOR_PG_POOL` (cross-tenant
 * in one tick, ADR-0098). Per employee, resolves a real IANA timezone
 * (`TimezoneResolverService`, ADR-0099) rather than assuming UTC
 * uniformly - `'day'` means each employee's own local calendar day.
 *
 * "Idempotent and resumable" (§2.2 rule 4): the `ON CONFLICT ... DO
 * UPDATE` inside `DAILY_ROLLUP_SQL` makes a re-run for a day already
 * computed converge on the identical result, never a duplicate row - a
 * crashed prior tick or simply the next scheduled tick re-running the
 * same trailing window catches up without any separate checkpoint.
 */
@Injectable()
export class AdherenceDailyRollupJobService {
  private readonly logger = new Logger(AdherenceDailyRollupJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly timezoneResolver: TimezoneResolverService,
  ) {}

  @Cron('*/15 * * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    const start = process.hrtime.bigint();
    try {
      await this.rollupTrailingWindow(new Date());
      this.metrics.recordRollupJobRun('fifteen_minute', 'success');
    } catch (err) {
      this.metrics.recordRollupJobRun('fifteen_minute', 'error');
      this.logger.error(`Daily rollup tick failed: ${(err as Error).message}`);
    } finally {
      this.metrics.observeRollupJobLag('fifteen_minute', secondsSince(start));
      this.ticking = false;
    }
  }

  /**
   * One raw scan window covers the whole trailing period - no per-day
   * loop (the SQL's own `GROUP BY local_day` handles every local day the
   * window touches in one pass per timezone group). The window is padded
   * a full day on each side of the UTC-naive trailing range so that no
   * timezone's own local day (up to UTC-12/UTC+14 offset) is clipped by
   * the raw scan bounds themselves - a generous, deliberately-not-tight
   * bound; correctness comes from the `AT TIME ZONE`-based bucketing
   * inside the query, not from this outer window being exact.
   */
  async rollupTrailingWindow(now: Date): Promise<void> {
    const trailingDays = getNumberConfig(this.config, 'ADHERENCE_DAILY_ROLLUP_TRAILING_DAYS', 2);
    const majorDeviationThresholdSeconds = getNumberConfig(
      this.config,
      'ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS',
      300,
    );
    const scanStart = new Date(now.getTime() - (trailingDays + 1) * 24 * 60 * 60 * 1000);
    const scanEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const { rows } = await this.pool.query<{ tenant_id: string; employee_id: string }>(DISTINCT_ACTIVE_EMPLOYEES_SQL, [
      scanStart,
      scanEnd,
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
        await this.pool.query(DAILY_ROLLUP_SQL, [
          tenantId,
          groupEmployeeIds,
          timezone,
          scanStart,
          scanEnd,
          majorDeviationThresholdSeconds,
        ]);
      }
    }
  }
}

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
