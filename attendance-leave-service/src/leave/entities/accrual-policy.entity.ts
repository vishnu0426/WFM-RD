import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { AccrualFrequency } from './accrual-frequency.enum';
import { AccrualPolicyStatus } from './accrual-policy-status.enum';

/**
 * User Management audit GAP-02: a real, self-contained accrual catalog —
 * see the migration's own doc comment for why this lives here rather than
 * as the cross-service `EmploymentPolicy` link `LeaveType.accrualPolicyId`'s
 * old doc comment aspired to (that link was never actually built).
 * `LeaveType.accrualPolicyId` still has no DB-level FK to this table, same
 * "no FK, service-layer validation" convention already used elsewhere in
 * this codebase for a polymorphic/cross-boundary reference.
 */
@Entity({ schema: 'attendance_leave', name: 'accrual_policy' })
export class AccrualPolicy {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar')
  name!: string;

  @Column('numeric', { precision: 6, scale: 2, name: 'accrual_rate_per_period' })
  accrualRatePerPeriod!: string;

  @Column('varchar', { name: 'accrual_frequency' })
  accrualFrequency!: AccrualFrequency;

  @Column('numeric', { precision: 6, scale: 2, name: 'max_balance_cap', nullable: true })
  maxBalanceCap!: string | null;

  @Column('varchar', { default: AccrualPolicyStatus.ACTIVE })
  status!: AccrualPolicyStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
