import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Phase 5 (ADR-0089) added `PENDING_APPROVAL` - the swap-side counterpart
 * to `MarketplaceClaimStatus.PENDING_APPROVAL` (§2.2 rule 2's own
 * "pending_validation is a distinct, required step before pending_approval"
 * principle, extended to the point *after* both sides validate but
 * *before* either an auto-approval policy or a supervisor commits the
 * trade to Module 04). `ACCEPTED` is reached only once approved - it is
 * not "both sides agreed," it is "this swap is going to
 * `SwapExecuted`/Module 04," matching `MarketplaceClaimStatus.APPROVED`'s
 * own meaning exactly.
 */
export enum SwapRequestStatus {
  PENDING = 'pending',
  PENDING_APPROVAL = 'pending_approval',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  SUPERSEDED = 'superseded',
}

/**
 * Phase 3 (ADR-0087) added, beyond the source spec's abbreviated §2.1 DDL:
 * `initiatorOrgUnitId`/`targetOrgUnitId` and `validationResult`.
 * `respondToSwap` runs a real guardrail check for *each* side of the trade
 * (would the initiator be eligible for the target's shift, and vice versa)
 * - `SchedulingEligibilityService.CheckAssignmentEligibility` needs an
 * `org_unit_id` per call to resolve that candidate's active
 * `EmploymentPolicy`, and the two shifts involved can belong to different
 * org units, so one swap-level org unit wouldn't be enough. `targetOrgUnitId`
 * follows `targetShiftId`'s own nullable-until-known lifecycle exactly - both
 * become known at the same moment (either `proposeSwap`, for a closed swap
 * naming both up front, or `respondToSwap`, for an open one).
 * `validationResult` mirrors `MarketplaceClaim`'s own field for the same
 * reason (§4 step 2's "clear reason on rejection, not just a generic
 * failure" applies here too, now covering *both* sides' outcomes).
 */
@Entity({ name: 'swap_request', schema: 'marketplace' })
export class SwapRequest {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'initiator_employee_id' })
  initiatorEmployeeId!: string;

  // Cross-module reference into Module 04's ShiftAssignment.
  @Column('uuid', { name: 'initiator_shift_id' })
  initiatorShiftId!: string;

  @Column('uuid', { name: 'initiator_org_unit_id' })
  initiatorOrgUnitId!: string;

  // Null = open swap (any eligible employee may accept, not one named
  // target).
  @Column('uuid', { name: 'target_employee_id', nullable: true })
  targetEmployeeId!: string | null;

  @Column('uuid', { name: 'target_shift_id', nullable: true })
  targetShiftId!: string | null;

  @Column('uuid', { name: 'target_org_unit_id', nullable: true })
  targetOrgUnitId!: string | null;

  @Column('varchar', { default: SwapRequestStatus.PENDING })
  status!: SwapRequestStatus;

  // Tenant-policy-driven (§0.5's progressive-delivery row: high-blast-radius
  // auto-approval defaults off) - defaults to `true` (supervisor approval
  // required) at the column level, same "safe default, explicit opt-in"
  // posture as Module 04/05's own high-blast-radius capabilities.
  @Column('boolean', { name: 'requires_supervisor_approval', default: true })
  requiresSupervisorApproval!: boolean;

  @Column('jsonb', { name: 'validation_result', nullable: true })
  validationResult!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  /** Shift Marketplace Manager View phase, §2 - same reasoning as `MarketplaceClaim.decisionReason`. */
  @Column('text', { name: 'decision_reason', nullable: true })
  decisionReason!: string | null;
}
