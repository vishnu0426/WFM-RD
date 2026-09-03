import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum LeaveRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

/**
 * §2.2 rule 2: `conflictFlags` is always populated synchronously at request
 * time (Phase 3's gRPC/REST conflict-check pipeline), never deferred to
 * approval time - the column exists from this phase, the write path lands
 * in Phase 3. §5.1: `isBackdated` is derived (`dateRangeStart < requestedAt`
 * at submission time), never client-supplied - Phase 3/6 enforce that in
 * application code; this migration only shapes the column. `backdatedReason`/
 * `backdatedApprovedBy` ship now (not retrofitted) per the module prompt,
 * even though the elevated-permission enforcement they require is Phase 6
 * scope.
 */
@Entity({ name: 'leave_request', schema: 'attendance_leave' })
export class LeaveRequest {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('uuid', { name: 'leave_type_id' })
  leaveTypeId!: string;

  @Column('date', { name: 'date_range_start' })
  dateRangeStart!: string;

  @Column('date', { name: 'date_range_end' })
  dateRangeEnd!: string;

  @Column('varchar', { default: LeaveRequestStatus.PENDING })
  status!: LeaveRequestStatus;

  @Column('uuid', { name: 'approval_chain_id', nullable: true })
  approvalChainId!: string | null;

  @Column('timestamptz', { name: 'requested_at' })
  requestedAt!: Date;

  @Column('timestamptz', { name: 'decided_at', nullable: true })
  decidedAt!: Date | null;

  @Column('uuid', { name: 'decided_by', nullable: true })
  decidedBy!: string | null;

  @Column('jsonb', { name: 'conflict_flags', default: {} })
  conflictFlags!: Record<string, unknown>;

  @Column('boolean', { name: 'is_backdated', default: false })
  isBackdated!: boolean;

  @Column('text', { name: 'backdated_reason', nullable: true })
  backdatedReason!: string | null;

  @Column('uuid', { name: 'backdated_approved_by', nullable: true })
  backdatedApprovedBy!: string | null;

  /**
   * Attendance & Leave Manager Views phase: the manager approval queue's
   * §2 requirement for "a required comment field on reject" - a bare
   * rejection with no reason is a poor experience for the employee on the
   * other end. Only ever set on a `rejected` decision (enforced in
   * `DecideLeaveRequestDto`, not here); an approved decision leaves this
   * null.
   */
  @Column('text', { name: 'decision_reason', nullable: true })
  decisionReason!: string | null;
}
