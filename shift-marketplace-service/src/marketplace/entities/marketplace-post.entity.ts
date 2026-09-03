import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum MarketplacePostType {
  OPEN_SHIFT = 'open_shift',
  SWAP = 'swap',
  BID = 'bid',
}

export enum MarketplacePostStatus {
  OPEN = 'open',
  CLAIMED = 'claimed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * §2.1/§2.2 rule 1: `eligibilityRules` is not a separate, hand-maintained
 * rule set - it is a runtime re-check against Module 04's actual constraint
 * logic, called via gRPC (ADR-0082) each time a claim/swap/bid is
 * attempted against this post. This column stores the post's *own* declared
 * eligibility scope (e.g. required skill/org unit, if narrower than the
 * shift's own), never a cached pass/fail verdict - `MarketplaceClaim.
 * validationResult` is where a specific claim attempt's real guardrail
 * outcome lives.
 */
@Entity({ name: 'marketplace_post', schema: 'marketplace' })
export class MarketplacePost {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'post_type' })
  postType!: MarketplacePostType;

  // Cross-module reference into Module 04's ShiftAssignment - plain uuid,
  // never a SQL REFERENCES (ADR-0052/0073's convention): referential
  // correctness for a cross-module id is the gRPC/REST-contract boundary's
  // concern, not Postgres's.
  @Column('uuid', { name: 'shift_assignment_id' })
  shiftAssignmentId!: string;

  // Added beyond the source spec's abbreviated DDL (§2.1 doesn't list it
  // for MarketplacePost) - needed because §3.1's `marketplacePostUpdated
  // (orgUnitId)` subscription is scoped by org unit, and scheduling-
  // service's own `ShiftAssignment` table carries no `org_unit_id` of its
  // own (only its `Schedule` does) - denormalized here, populated by
  // whatever creates the post (it already knows the shift's site), rather
  // than requiring a live lookup on every claim/subscribe.
  @Column('uuid', { name: 'org_unit_id' })
  orgUnitId!: string;

  // Nullable: null = system-posted (e.g. an unfilled open shift auto-posted
  // by a coverage gap), non-null = employee-initiated - §2.2 rule 4's
  // actor_type distinction, mirrored from Module 01's AuditLog design.
  @Column('uuid', { name: 'posted_by', nullable: true })
  postedBy!: string | null;

  @Column('varchar', { default: MarketplacePostStatus.OPEN })
  status!: MarketplacePostStatus;

  @Column('jsonb', { name: 'eligibility_rules', default: {} })
  eligibilityRules!: Record<string, unknown>;

  @Column('timestamptz', { name: 'expires_at' })
  expiresAt!: Date;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
