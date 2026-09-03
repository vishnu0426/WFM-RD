import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.2 rule 3: a real, queryable, auditable entity - not a frontend-computed
 * number. This table only holds the current running totals; every
 * individual point/badge/streak *change* must be traceable to which action
 * earned it and when - Phase 7's own job (a ledger table/NATS-consumed
 * event log), not retrofitted here. `claimAttemptCountWindow`/
 * `claimAttemptWindowStart` (§5.2) are this row's anti-abuse rate-limit
 * counters - ship from this migration per the module prompt's "not
 * retrofitted" instruction, even though the enforcement logic that reads/
 * writes them is Phase 6 scope.
 */
@Entity({ name: 'marketplace_engagement_score', schema: 'marketplace' })
export class MarketplaceEngagementScore {
  @PrimaryColumn('uuid', { name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('integer', { default: 0 })
  points!: number;

  @Column('integer', { name: 'streak_days', default: 0 })
  streakDays!: number;

  @Column('jsonb', { default: [] })
  badges!: unknown[];

  @Column('integer', { name: 'claim_attempt_count_window', nullable: true })
  claimAttemptCountWindow!: number | null;

  @Column('timestamptz', { name: 'claim_attempt_window_start', nullable: true })
  claimAttemptWindowStart!: Date | null;

  /**
   * Phase 7 (ADR-0091): the calendar date (UTC, this platform's own
   * no-per-tenant-timezone-concept placeholder posture) of the most recent
   * qualifying engagement event - `MarketplaceEngagementService` reads this
   * to decide "consecutive day" (`streak_days + 1`) vs. "gap" (reset to 1)
   * without re-deriving it from a full `marketplace_engagement_event` scan.
   */
  @Column('date', { name: 'last_engagement_date', nullable: true })
  lastEngagementDate!: string | null;
}
