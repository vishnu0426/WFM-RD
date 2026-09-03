import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * GAP-02 fix (enterprise readiness audit, 2026-08-18): the transactional
 * outbox for `ShiftClaimApproved`/`SwapExecuted` - see
 * `1700005000000-MarketplaceOutboxSchema` for the full rationale. Written
 * in the *same* database transaction as the claim/swap status change it
 * describes (`MarketplaceEventPublisherService.recordClaimApproved`/
 * `.recordSwapExecuted`, called from inside each caller's own
 * `withTenantConnection` block) - `MarketplaceOutboxPublisherService` is the
 * only writer of `publishedAt`/`claimedAt`/`attempts`/`lastError`, on its
 * own independent schedule.
 */
@Entity({ schema: 'marketplace', name: 'marketplace_outbox_event' })
export class MarketplaceOutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** e.g. `agno.marketplace.claim.approved.v1` - see `src/nats/subjects.ts`. */
  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  /** Lease: set when a poller claims this row; a stale claim is reclaimable - see `MarketplaceOutboxEventsRepository.findUnpublishedBatch`. */
  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;
}
