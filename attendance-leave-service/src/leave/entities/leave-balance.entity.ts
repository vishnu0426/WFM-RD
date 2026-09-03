import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1/§2.2 rule 1 (ADR-0074): composite PK `(employeeId, leaveTypeId,
 * periodStart, periodEnd)`, exactly as the module prompt specifies - this
 * is deliberate, not incidental, because it is also the row-lock
 * granularity Phase 3's concurrency-safe submission check
 * (`SELECT ... FOR UPDATE` on this exact key) depends on. `pendingDays` is
 * tracked separately from `usedDays` so `availableDays` (a GraphQL computed
 * field added in a later phase, not a column here - it's
 * `accruedDays - usedDays - pendingDays`, never stored) can be enforced
 * transactionally rather than via an application-level read-then-write that
 * races under concurrent requests. `carryoverDaysIn`/`carryoverExpiryDate`
 * (§5.2) ship in this same migration rather than a later ALTER, per the
 * module prompt's explicit "not retrofitted" instruction.
 */
@Entity({ name: 'leave_balance', schema: 'attendance_leave' })
export class LeaveBalance {
  @PrimaryColumn('uuid', { name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn('uuid', { name: 'leave_type_id' })
  leaveTypeId!: string;

  @PrimaryColumn('date', { name: 'period_start' })
  periodStart!: string;

  @PrimaryColumn('date', { name: 'period_end' })
  periodEnd!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('numeric', { name: 'accrued_days', precision: 6, scale: 2, default: 0 })
  accruedDays!: string;

  @Column('numeric', { name: 'used_days', precision: 6, scale: 2, default: 0 })
  usedDays!: string;

  @Column('numeric', { name: 'pending_days', precision: 6, scale: 2, default: 0 })
  pendingDays!: string;

  @Column('numeric', { name: 'carryover_days_in', precision: 6, scale: 2, default: 0 })
  carryoverDaysIn!: string;

  @Column('date', { name: 'carryover_expiry_date', nullable: true })
  carryoverExpiryDate!: string | null;

  /** §5.2/ADR-0080 (Phase 7): the rollover job's own idempotency marker - see that migration's doc comment for why `carryover_days_in = 0` alone can't serve this role. */
  @Column('boolean', { name: 'carryover_applied', default: false })
  carryoverApplied!: boolean;

  /** User Management audit GAP-02: `LeaveAccrualJobService`'s own idempotency marker — same role `carryoverApplied` plays for the rollover job, but a date rather than a flag since accrual recurs every period instead of firing once. */
  @Column('date', { name: 'last_accrued_at', nullable: true })
  lastAccruedAt!: string | null;
}
