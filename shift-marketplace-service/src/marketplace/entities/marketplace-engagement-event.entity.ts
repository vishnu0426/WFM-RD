import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum MarketplaceEngagementEventType {
  CLAIM_APPROVED = 'claim_approved',
  SWAP_EXECUTED = 'swap_executed',
}

/**
 * Phase 7 (§2.2 rule 3, ADR-0091): the ledger `marketplace_engagement_score`'s
 * own doc comment promised - append-only (no UPDATE/DELETE grant,
 * `1700002000000-MarketplaceEngagementLedgerSchema`'s own doc comment), one
 * row per point/streak/badge change, each traceable to the exact
 * `MarketplaceClaim`/`SwapRequest` (`referenceId`) that earned it and when
 * (`createdAt`). `streakDaysAfter`/`badgesAwarded` are this row's own
 * point-in-time snapshot - `MarketplaceEngagementScore` only ever holds the
 * *current* totals, this is the only place a query like "what was my streak
 * on March 3rd" or "which action earned me the `week_streak` badge" can be
 * answered from.
 */
@Entity({ name: 'marketplace_engagement_event', schema: 'marketplace' })
export class MarketplaceEngagementEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('varchar', { name: 'event_type' })
  eventType!: MarketplaceEngagementEventType;

  @Column('uuid', { name: 'reference_id' })
  referenceId!: string;

  @Column('integer', { name: 'points_delta' })
  pointsDelta!: number;

  @Column('integer', { name: 'streak_days_after' })
  streakDaysAfter!: number;

  @Column('jsonb', { name: 'badges_awarded', default: [] })
  badgesAwarded!: string[];

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
