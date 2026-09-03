import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §5.1: on `BidOpportunity` close, every `Bid` (not just the winner) gets a
 * `rankPosition` and a structured `rankExplanation` - the platform-wide
 * explainability principle (Module 03's forecast provenance, Module 04's
 * schedule explanation) applied here. `rankScore`/`rankPosition`/
 * `rankExplanation` are all null until close - there is nothing to rank
 * before the bidding window ends, same "computed at close" timing for all
 * three, not just the two §5.1 called out by name.
 */
@Entity({ name: 'bid', schema: 'marketplace' })
export class Bid {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  // Intra-schema reference - a real FK (see the migration).
  @Column('uuid', { name: 'bid_opportunity_id' })
  bidOpportunityId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('numeric', { name: 'rank_score', precision: 10, scale: 4, nullable: true })
  rankScore!: string | null;

  @Column('integer', { name: 'rank_position', nullable: true })
  rankPosition!: number | null;

  // Structured, per-ranking_method shape (§5.1: "the specific fields depend
  // on ranking_method, define the shape per method explicitly") - e.g.
  // `{ method: 'seniority', yourValue: '4 years', cutoffValue: '7 years',
  // yourPosition: 6, totalBidders: 12 }`. Read-only transparency, not an
  // appeal workflow (§5.1's own explicit scope boundary).
  @Column('jsonb', { name: 'rank_explanation', nullable: true })
  rankExplanation!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'submitted_at' })
  submittedAt!: Date;
}
