import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum BidRankingMethod {
  SENIORITY = 'seniority',
  PREFERENCE_SCORE = 'preference_score',
  FIRST_COME = 'first_come',
}

@Entity({ name: 'bid_opportunity', schema: 'marketplace' })
export class BidOpportunity {
  @PrimaryColumn('uuid')
  id!: string;

  // Added beyond the source spec's abbreviated DDL - see MarketplaceClaim's
  // own comment on the same addition.
  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  // Intra-schema reference - a real FK (see the migration).
  @Column('uuid', { name: 'marketplace_post_id' })
  marketplacePostId!: string;

  @Column('timestamptz', { name: 'bidding_window_start' })
  biddingWindowStart!: Date;

  @Column('timestamptz', { name: 'bidding_window_end' })
  biddingWindowEnd!: Date;

  @Column('varchar', { name: 'ranking_method' })
  rankingMethod!: BidRankingMethod;
}
