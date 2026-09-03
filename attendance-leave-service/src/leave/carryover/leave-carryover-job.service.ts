import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MetricsService } from '../../common/metrics/metrics.service';

/**
 * §5.2/ADR-0080's rollover step: for every `LeaveBalance` "successor"
 * period not yet processed (`carryover_applied = false`) whose immediate
 * predecessor period (same employee/leave type, contiguous dates) has
 * already closed (`period_end < CURRENT_DATE`), compute the capped
 * carryover from the predecessor's own leftover
 * (`accrued_days - used_days - pending_days`, floored at 0, capped at
 * `LeaveType.carryover_rules.maxCarryoverDays`) and fold it into the
 * successor's `accrued_days`, recording the amount (`carryover_days_in`)
 * and, if `carryoverExpiryMonths` is configured, an expiry date computed
 * from the successor's own `period_start`.
 *
 * A single cross-tenant `UPDATE ... FROM ... JOIN LATERAL` - not a
 * per-tenant loop, not a ledger/checkpoint table (contrast Module 02's
 * skill-decay job, ADR-0017): unlike decay (a continuous recompute with no
 * natural terminal state), rollover is a genuine one-time-per-period
 * event, and `carryover_applied` is that terminal state, living on the row
 * itself. A crash mid-statement is not a partial-application risk -
 * Postgres's own statement-level atomicity means the UPDATE either fully
 * commits or fully rolls back; a crash *between* ticks just means some
 * rows are still `carryover_applied = false` and the next tick picks them
 * up, no separate resume-cursor bookkeeping required. This mirrors
 * intraday-service's own `AdherenceRollupSchedulerService` precedent (a
 * single idempotent cross-tenant SQL statement via the migrator pool, not
 * an app-level per-tenant/per-row loop) more closely than the decay job's
 * heavier ledger pattern - the right precedent to follow depends on
 * whether the underlying operation has a natural completion marker, and
 * this one does.
 */
const ROLLOVER_SQL = `
  UPDATE attendance_leave.leave_balance AS successor
  SET
    accrued_days = successor.accrued_days + capped.amount,
    carryover_days_in = capped.amount,
    carryover_expiry_date = capped.expiry_date,
    carryover_applied = true
  FROM attendance_leave.leave_balance AS predecessor
  JOIN attendance_leave.leave_type AS lt ON lt.id = predecessor.leave_type_id
  JOIN LATERAL (
    SELECT
      GREATEST(
        LEAST(
          predecessor.accrued_days - predecessor.used_days - predecessor.pending_days,
          COALESCE(
            CASE WHEN (lt.carryover_rules ->> 'maxCarryoverDays') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (lt.carryover_rules ->> 'maxCarryoverDays')::numeric
                 ELSE NULL END,
            0
          )
        ),
        0
      ) AS amount,
      -- predecessor.period_end + 1, not successor.period_start - Postgres
      -- does not allow a LATERAL item in an UPDATE's FROM/JOIN list to
      -- reference the UPDATE target's own alias (only WHERE/SET can); the
      -- WHERE clause below already constrains these two to be equal, so
      -- this computes the identical value without that reference (a real
      -- bug caught by this phase's own real-Postgres verification, not a
      -- hypothetical - see ADR-0080).
      CASE WHEN (lt.carryover_rules ->> 'carryoverExpiryMonths') ~ '^[0-9]+$'
           THEN ((predecessor.period_end + 1) + ((lt.carryover_rules ->> 'carryoverExpiryMonths')::int || ' months')::interval)::date
           ELSE NULL END AS expiry_date
  ) AS capped ON true
  WHERE successor.tenant_id = predecessor.tenant_id
    AND successor.employee_id = predecessor.employee_id
    AND successor.leave_type_id = predecessor.leave_type_id
    AND successor.period_start = predecessor.period_end + 1
    AND successor.carryover_applied = false
    AND predecessor.period_end < CURRENT_DATE
  RETURNING capped.amount;
`;

/**
 * §5.2/ADR-0080's expiry step: any `LeaveBalance` row still holding
 * unused, expired carryover (`carryover_days_in > 0`, a real
 * `carryover_expiry_date` in the past) has the *unused portion* of that
 * carryover clawed back from `accrued_days` - `LEAST(carryover_days_in,
 * availableDays)`, never more than what is actually still available
 * (an employee who has already used more than their carryover amount
 * against other, non-expiring accrual has nothing left of the expired
 * carryover specifically to claw back). The CTE captures the clawback
 * amount from the *pre-update* row - `RETURNING` alone would see the
 * post-update (already-zeroed) `carryover_days_in`, not the amount that
 * was actually removed.
 *
 * `carryover_days_in > 0` doubles as this job's own idempotency marker,
 * exactly as `carryover_applied` does for the rollover job above - once
 * cleared, the row no longer matches.
 */
const EXPIRY_SQL = `
  WITH expired AS (
    SELECT
      tenant_id, employee_id, leave_type_id, period_start, period_end,
      LEAST(carryover_days_in, GREATEST(accrued_days - used_days - pending_days, 0)) AS clawback
    FROM attendance_leave.leave_balance
    WHERE carryover_days_in > 0
      AND carryover_expiry_date IS NOT NULL
      AND carryover_expiry_date < CURRENT_DATE
  )
  UPDATE attendance_leave.leave_balance AS lb
  SET
    accrued_days = lb.accrued_days - expired.clawback,
    carryover_days_in = 0,
    carryover_expiry_date = NULL
  FROM expired
  WHERE lb.tenant_id = expired.tenant_id
    AND lb.employee_id = expired.employee_id
    AND lb.leave_type_id = expired.leave_type_id
    AND lb.period_start = expired.period_start
    AND lb.period_end = expired.period_end
  RETURNING expired.clawback;
`;

@Injectable()
export class LeaveCarryoverJobService {
  private readonly logger = new Logger(LeaveCarryoverJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * One fixed daily tick for both steps, not per-tenant-local-midnight
   * (contrast Module 02's decay job) - carryover/expiry are date-boundary
   * events, not continuous ones, and this module has no existing
   * per-tenant-timezone lookup to build on (a real gap, flagged in the
   * design doc rather than built here). Rollover runs before expiry in the
   * same tick.
   *
   * Under normal (non-backlogged) operation, a row that just received
   * carryover today gets a *future* expiry date, so it cannot also match
   * expiry's "expiry date in the past" condition in the same tick - but
   * this is not a guarantee, and this phase's own real-Postgres
   * verification caught the case where it doesn't hold: if the rollover
   * job has fallen far enough behind that a period's carryover is only
   * computed well after `periodStart + carryoverExpiryMonths` has already
   * passed (e.g. this service was down for months), the freshly-applied
   * carryover is *already* expired, and the expiry step claws it back in
   * this same tick. That is the correct outcome, not a bug: the rule is
   * "carryover expires N months after the period starts," and an
   * operational delay in applying it does not entitle the balance to an
   * extended expiry nobody configured - see the design doc's explicit
   * assumptions.
   */
  @Cron('0 3 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.rolloverTick();
      await this.expiryTick();
    } finally {
      this.ticking = false;
    }
  }

  private async rolloverTick(): Promise<void> {
    try {
      const result = await this.pool.query<{ amount: string }>(ROLLOVER_SQL);
      const daysRolledOver = result.rows.reduce((sum, row) => sum + Number(row.amount), 0);
      this.metrics.recordCarryoverRolloverRun('success', result.rowCount ?? 0, daysRolledOver);
    } catch (err) {
      this.logger.error(`Carryover rollover tick failed: ${(err as Error).message}`);
      this.metrics.recordCarryoverRolloverRun('error');
    }
  }

  private async expiryTick(): Promise<void> {
    try {
      const result = await this.pool.query<{ clawback: string }>(EXPIRY_SQL);
      const daysExpired = result.rows.reduce((sum, row) => sum + Number(row.clawback), 0);
      this.metrics.recordCarryoverExpiryRun('success', result.rowCount ?? 0, daysExpired);
    } catch (err) {
      this.logger.error(`Carryover expiry tick failed: ${(err as Error).message}`);
      this.metrics.recordCarryoverExpiryRun('error');
    }
  }
}
