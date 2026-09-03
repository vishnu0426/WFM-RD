import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MetricsService } from '../../common/metrics/metrics.service';

/**
 * User Management audit GAP-02: the recurring accrual job the previously-
 * disclosed gap said didn't exist. Same shape as `LeaveCarryoverJobService`
 * right above it in this directory — a single cross-tenant `UPDATE ...
 * FROM ... JOIN` via the migrator pool, not a per-tenant loop, since this
 * is a genuine periodic recompute with its own idempotency marker
 * (`last_accrued_at`) rather than a ledger needing resume-cursor
 * bookkeeping.
 *
 * Only balance rows whose *period is currently open* (`period_start <=
 * today <= period_end`) are eligible — accruing into an already-closed or
 * not-yet-started period has no meaning. `max_balance_cap` on the policy,
 * when set, is a hard ceiling: an employee already at or above the cap
 * simply stops accruing further (no partial top-up to exactly the cap —
 * simpler and matches how a cap is described to end users, "you stop
 * accruing at N days," not "you get exactly to N days this tick").
 */
const ACCRUAL_SQL = `
  UPDATE attendance_leave.leave_balance AS lb
  SET
    accrued_days = LEAST(
      lb.accrued_days + ap.accrual_rate_per_period,
      COALESCE(ap.max_balance_cap, lb.accrued_days + ap.accrual_rate_per_period)
    ),
    last_accrued_at = CURRENT_DATE
  FROM attendance_leave.leave_type lt
  JOIN attendance_leave.accrual_policy ap
    ON ap.id = lt.accrual_policy_id AND ap.tenant_id = lt.tenant_id AND ap.status = 'active'
  WHERE lb.leave_type_id = lt.id
    AND lb.tenant_id = lt.tenant_id
    AND lb.period_start <= CURRENT_DATE
    AND lb.period_end >= CURRENT_DATE
    AND (ap.max_balance_cap IS NULL OR lb.accrued_days < ap.max_balance_cap)
    AND (
      (ap.accrual_frequency = 'weekly' AND (lb.last_accrued_at IS NULL OR lb.last_accrued_at <= CURRENT_DATE - INTERVAL '7 days'))
      OR (ap.accrual_frequency = 'biweekly' AND (lb.last_accrued_at IS NULL OR lb.last_accrued_at <= CURRENT_DATE - INTERVAL '14 days'))
      OR (ap.accrual_frequency = 'monthly' AND (lb.last_accrued_at IS NULL OR date_trunc('month', lb.last_accrued_at::timestamp) < date_trunc('month', CURRENT_DATE::timestamp)))
      OR (ap.accrual_frequency = 'annually' AND (lb.last_accrued_at IS NULL OR date_trunc('year', lb.last_accrued_at::timestamp) < date_trunc('year', CURRENT_DATE::timestamp)))
    )
  RETURNING ap.accrual_rate_per_period AS amount;
`;

@Injectable()
export class LeaveAccrualJobService {
  private readonly logger = new Logger(LeaveAccrualJobService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  /** Runs daily; each row's own frequency check (above) decides whether that tick actually accrues it — a daily cron with a weekly/monthly/annual *condition* is simpler and less drift-prone than separate weekly/monthly/annual cron expressions. */
  @Cron('30 3 * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const result = await this.pool.query<{ amount: string }>(ACCRUAL_SQL);
      const daysAccrued = result.rows.reduce((sum, row) => sum + Number(row.amount), 0);
      this.metrics.recordLeaveAccrualRun('success', result.rowCount ?? 0, daysAccrued);
    } catch (err) {
      this.logger.error(`Leave accrual tick failed: ${(err as Error).message}`);
      this.metrics.recordLeaveAccrualRun('error');
    } finally {
      this.ticking = false;
    }
  }
}
