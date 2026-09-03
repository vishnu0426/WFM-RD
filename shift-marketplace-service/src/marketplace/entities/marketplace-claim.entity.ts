import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.2 rule 2: `pending_validation` is a distinct, required step before
 * `pending_approval` - the actual concurrency-safety mechanism (§3.3/§4).
 * An invalid claim must never occupy the "competing for approval" slot and
 * block a valid one - never collapsed into one status.
 */
export enum MarketplaceClaimStatus {
  PENDING_VALIDATION = 'pending_validation',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUPERSEDED = 'superseded',
}

/**
 * ADR-0159: which mechanism produced this claim - `ClaimOpenShiftService`
 * (first-come) or `BidService.closeBidOpportunity` (a ranked bid win).
 * Needed at approval time (`ApproveMarketplaceActionService.approveClaim`
 * may run long after the claim was created, so it can't infer this from
 * call-site context) to tell scheduling-service's NATS consumer which
 * `assignment_source` value applies - `bid` has been a valid value in
 * `scheduling.shift_assignments.assignment_source` since Module 04's
 * very first migration, reserved for exactly this and never populated
 * until now.
 */
export enum MarketplaceClaimSource {
  OPEN_SHIFT_CLAIM = 'open_shift_claim',
  BID = 'bid',
}

@Entity({ name: 'marketplace_claim', schema: 'marketplace' })
export class MarketplaceClaim {
  @PrimaryColumn('uuid')
  id!: string;

  // Added beyond the source spec's abbreviated DDL - every table in this
  // schema carries tenant_id for the RLS tenant_isolation policy
  // (ADR-0002), including ones the module prompt's own §2.1 block didn't
  // spell it out for.
  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  // Intra-schema reference (both tables live in `marketplace`) - a real FK,
  // unlike the cross-module uuid-only references elsewhere in this entity
  // set. See the migration's REFERENCES clause.
  @Column('uuid', { name: 'marketplace_post_id' })
  marketplacePostId!: string;

  @Column('uuid', { name: 'claimant_employee_id' })
  claimantEmployeeId!: string;

  @Column('varchar', { default: MarketplaceClaimStatus.PENDING_VALIDATION })
  status!: MarketplaceClaimStatus;

  @Column('varchar', { default: MarketplaceClaimSource.OPEN_SHIFT_CLAIM })
  source!: MarketplaceClaimSource;

  // Structured guardrail check output (§4 step 2/5) - null until the
  // gRPC validation pipeline actually completes for this claim attempt,
  // populated regardless of pass/fail once it does (audit + a clear
  // rejection reason, not just a generic failure).
  @Column('jsonb', { name: 'validation_result', nullable: true })
  validationResult!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'claimed_at' })
  claimedAt!: Date;

  /**
   * Shift Marketplace Manager View phase, §2: `rejectMarketplaceAction`'s
   * required `reason` argument, persisted so the employee side of this
   * platform (Module 11's mobile app) has something real to show rather
   * than a bare status flip - same "a bare rejection with no reason is a
   * poor experience" reasoning attendance-leave-service's own
   * `decisionReason` column already applied to leave decisions. Null for
   * every other status - only ever set by a rejection.
   */
  @Column('text', { name: 'decision_reason', nullable: true })
  decisionReason!: string | null;
}
