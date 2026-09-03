import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MetricsService } from '../../common/metrics/metrics.service';
import { getNumberConfig } from '../../common/config/get-number-config';
import { CalendarGrpcClientService } from '../../grpc/calendar-grpc-client.service';

/**
 * §2.1's three `AbsencePatternType` values (`frequency_threshold`,
 * `recurring_day_of_week`, `pre_post_holiday`) - `no_show` pattern
 * detection is deliberately not one of them (confirmed against the Phase 1
 * schema's own `pattern_type` CHECK constraint) and stays unbuilt, same
 * gap flagged since Phase 1/5: it would need a proactive
 * scheduled-shift-vs-no-clock-in sweep this module has never built, a
 * distinct feature from detecting a *pattern* across already-recorded
 * `LeaveRequest`/attendance data.
 *
 * Same "single idempotent cross-tenant SQL statement via the migrator
 * pool" posture as `LeaveCarryoverJobService` (Phase 7, ADR-0080) for the
 * two steps that don't need an external dependency
 * (`frequency_threshold`/`recurring_day_of_week`). `pre_post_holiday` is
 * the exception: it needs a real holiday calendar
 * (`CalendarGrpcClientService`, this service's second gRPC client), which
 * is tenant-scoped and can't be folded into one cross-tenant SQL
 * statement - that step loops over tenants with any recent leave activity,
 * one gRPC call each, one parameterized SQL statement per tenant. A
 * failure fetching one tenant's calendar is caught and logged per-tenant,
 * not allowed to abort every other tenant's detection for that tick.
 *
 * Idempotency/dedup for all three steps: `WHERE NOT EXISTS (... AND
 * acknowledged_by IS NULL)` - at most one *unacknowledged* row per
 * `(tenant_id, employee_id, pattern_type)` at a time. Re-running the
 * detection query for a pattern already flagged and still unacknowledged
 * is a correct no-op, not a duplicate; once acknowledged
 * (`AcknowledgeAbsencePatternService`), a still-ongoing pattern is free to
 * be detected again fresh on the next tick - see ADR-0081.
 *
 * Confidence scores are an explicit, documented heuristic, not a
 * statistical model the module prompt specifies: `frequency_threshold`/
 * `pre_post_holiday` use `LEAST(1.0, count / (threshold * 2))` (0.5 right
 * at the threshold, saturating at double it); `recurring_day_of_week`
 * uses the day-of-week's actual share of the employee's total absence-days
 * directly, since that is already a natural, bounded [0,1] proportion.
 */
@Injectable()
export class AbsencePatternDetectionJob {
  private readonly logger = new Logger(AbsencePatternDetectionJob.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly calendarClient: CalendarGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('0 4 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.frequencyThresholdStep();
      await this.recurringDayOfWeekStep();
      await this.prePostHolidayStep();
    } finally {
      this.ticking = false;
    }
  }

  private async frequencyThresholdStep(): Promise<void> {
    const thresholdDays = getNumberConfig(this.config, 'ABSENCE_PATTERN_FREQUENCY_THRESHOLD_DAYS', 10);
    const windowDays = getNumberConfig(this.config, 'ABSENCE_PATTERN_FREQUENCY_WINDOW_DAYS', 90);
    try {
      const result = await this.pool.query(
        `
          INSERT INTO attendance_leave.absence_pattern (tenant_id, employee_id, pattern_type, confidence_score)
          SELECT
            agg.tenant_id, agg.employee_id, 'frequency_threshold',
            LEAST(1.0, agg.total_days::numeric / ($1::numeric * 2))
          FROM (
            SELECT tenant_id, employee_id, SUM((date_range_end - date_range_start) + 1) AS total_days
            FROM attendance_leave.leave_request
            WHERE status = 'approved' AND date_range_start >= (CURRENT_DATE - $2::int)
            GROUP BY tenant_id, employee_id
          ) AS agg
          WHERE agg.total_days >= $1
            AND NOT EXISTS (
              SELECT 1 FROM attendance_leave.absence_pattern ap
              WHERE ap.tenant_id = agg.tenant_id AND ap.employee_id = agg.employee_id
                AND ap.pattern_type = 'frequency_threshold' AND ap.acknowledged_by IS NULL
            )
          RETURNING employee_id;
        `,
        [thresholdDays, windowDays],
      );
      this.metrics.recordAbsencePatternDetectionRun('frequency_threshold', 'success', result.rowCount ?? 0);
    } catch (err) {
      this.logger.error(`Absence pattern detection (frequency_threshold) failed: ${(err as Error).message}`);
      this.metrics.recordAbsencePatternDetectionRun('frequency_threshold', 'error');
    }
  }

  private async recurringDayOfWeekStep(): Promise<void> {
    const windowDays = getNumberConfig(this.config, 'ABSENCE_PATTERN_RECURRING_WINDOW_DAYS', 180);
    const minSampleDays = getNumberConfig(this.config, 'ABSENCE_PATTERN_RECURRING_MIN_SAMPLE_DAYS', 5);
    const shareThreshold = getNumberConfig(this.config, 'ABSENCE_PATTERN_RECURRING_SHARE_THRESHOLD', 0.4);
    try {
      const result = await this.pool.query(
        `
          INSERT INTO attendance_leave.absence_pattern (tenant_id, employee_id, pattern_type, confidence_score)
          SELECT agg.tenant_id, agg.employee_id, 'recurring_day_of_week', agg.max_share
          FROM (
            SELECT
              tenant_id, employee_id,
              MAX(day_count)::numeric / SUM(day_count)::numeric AS max_share,
              SUM(day_count) AS total_days
            FROM (
              SELECT lr.tenant_id, lr.employee_id, EXTRACT(DOW FROM d)::int AS dow, COUNT(*) AS day_count
              FROM attendance_leave.leave_request AS lr
              CROSS JOIN LATERAL generate_series(lr.date_range_start, lr.date_range_end, interval '1 day') AS d
              WHERE lr.status = 'approved' AND lr.date_range_start >= (CURRENT_DATE - $1::int)
              GROUP BY lr.tenant_id, lr.employee_id, EXTRACT(DOW FROM d)
            ) AS by_dow
            GROUP BY tenant_id, employee_id
          ) AS agg
          WHERE agg.total_days >= $2 AND agg.max_share >= $3
            AND NOT EXISTS (
              SELECT 1 FROM attendance_leave.absence_pattern ap
              WHERE ap.tenant_id = agg.tenant_id AND ap.employee_id = agg.employee_id
                AND ap.pattern_type = 'recurring_day_of_week' AND ap.acknowledged_by IS NULL
            )
          RETURNING employee_id;
        `,
        [windowDays, minSampleDays, shareThreshold],
      );
      this.metrics.recordAbsencePatternDetectionRun('recurring_day_of_week', 'success', result.rowCount ?? 0);
    } catch (err) {
      this.logger.error(`Absence pattern detection (recurring_day_of_week) failed: ${(err as Error).message}`);
      this.metrics.recordAbsencePatternDetectionRun('recurring_day_of_week', 'error');
    }
  }

  /**
   * Per-`LeaveRequest` adjacency (`dateRangeStart - 1` or `dateRangeEnd +
   * 1` is a holiday), not per-expanded-day like the recurring-day-of-week
   * step - this is deliberately about whether the employee's leave *block*
   * bridges a holiday (extending a long weekend), which is the actual
   * behavior §2.1 names, not "does any day within a long leave request
   * happen to sit near a holiday."
   */
  private async prePostHolidayStep(): Promise<void> {
    const windowDays = getNumberConfig(this.config, 'ABSENCE_PATTERN_HOLIDAY_WINDOW_DAYS', 180);
    const thresholdCount = getNumberConfig(this.config, 'ABSENCE_PATTERN_HOLIDAY_THRESHOLD_COUNT', 2);

    let tenantIds: string[];
    try {
      const tenantsResult = await this.pool.query<{ tenant_id: string }>(
        `
          SELECT DISTINCT tenant_id FROM attendance_leave.leave_request
          WHERE status = 'approved' AND date_range_start >= (CURRENT_DATE - $1::int);
        `,
        [windowDays],
      );
      tenantIds = tenantsResult.rows.map((row) => row.tenant_id);
    } catch (err) {
      this.logger.error(
        `Absence pattern detection (pre_post_holiday) failed to list tenants: ${(err as Error).message}`,
      );
      this.metrics.recordAbsencePatternDetectionRun('pre_post_holiday', 'error');
      return;
    }

    let totalDetected = 0;
    let anyFailure = false;
    const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    // The `leave_request` query below has no upper bound on `date_range_start`
    // (an already-*approved* request scheduled for future dates still
    // reflects real request-timing behavior, and is included the same way
    // the other two steps include future-dated approved requests) - so the
    // holiday lookup must extend into the future by the same window, not
    // stop at `today`, or a future request adjacent to a not-yet-fetched
    // holiday could never match. A real gap this phase's own verification
    // caught: an earlier version used `toDate: today`, which silently
    // missed every future-dated request's adjacent holiday (see ADR-0081).
    const windowEnd = new Date(Date.now() + windowDays * 86_400_000).toISOString().slice(0, 10);

    for (const tenantId of tenantIds) {
      try {
        const rules = await this.calendarClient.getWorkingTimeRules({
          tenantId,
          orgUnitId: '',
          fromDate: windowStart,
          toDate: windowEnd,
        });
        if (rules.holidayDates.length === 0) {
          continue;
        }
        const result = await this.pool.query(
          `
            INSERT INTO attendance_leave.absence_pattern (tenant_id, employee_id, pattern_type, confidence_score)
            SELECT agg.tenant_id, agg.employee_id, 'pre_post_holiday', LEAST(1.0, agg.cnt::numeric / ($2::numeric * 2))
            FROM (
              SELECT tenant_id, employee_id, COUNT(*) AS cnt
              FROM attendance_leave.leave_request AS lr
              WHERE lr.tenant_id = $1
                AND lr.status = 'approved'
                AND lr.date_range_start >= (CURRENT_DATE - $3::int)
                AND (
                  (lr.date_range_start - 1) = ANY($4::date[])
                  OR (lr.date_range_end + 1) = ANY($4::date[])
                )
              GROUP BY tenant_id, employee_id
            ) AS agg
            WHERE agg.cnt >= $2
              AND NOT EXISTS (
                SELECT 1 FROM attendance_leave.absence_pattern ap
                WHERE ap.tenant_id = agg.tenant_id AND ap.employee_id = agg.employee_id
                  AND ap.pattern_type = 'pre_post_holiday' AND ap.acknowledged_by IS NULL
              )
            RETURNING employee_id;
          `,
          [tenantId, thresholdCount, windowDays, rules.holidayDates],
        );
        totalDetected += result.rowCount ?? 0;
      } catch (err) {
        anyFailure = true;
        this.logger.error(
          `Absence pattern detection (pre_post_holiday) failed for tenant ${tenantId}: ${(err as Error).message}`,
        );
      }
    }

    this.metrics.recordAbsencePatternDetectionRun('pre_post_holiday', anyFailure ? 'error' : 'success', totalDetected);
  }
}
