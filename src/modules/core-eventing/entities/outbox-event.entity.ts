import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * ADR-0039: the `core`-schema transactional outbox for §4's `AuditEvent`/
 * `PolicyChanged` events - the counterpart to Module 02's `org.outbox_events`
 * (ADR-0019), same shape, deliberately a separate table/module rather than
 * a shared one (each module owns its own schema). Written in the *same*
 * database transaction as the entity change it describes
 * (`AuditLogRepository.record`, `PoliciesRepository.createLineage`/
 * `.supersede`) - `CoreOutboxPublisherService` is the only writer of
 * `publishedAt`/`attempts`/`lastError`, on its own independent schedule.
 */
@Entity({ schema: 'core', name: 'outbox_events' })
@Index('idx_outbox_events_tenant_id_published_at', ['tenantId', 'publishedAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** e.g. `agno.core.audit.created.v1` - see `src/modules/core-eventing/subjects.ts`. */
  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  /** GAP-14 lease: set when a poller claims this row, cleared implicitly by `publishedAt` being set; a stale claim (see `OUTBOX_CLAIM_LEASE_SECONDS`) is reclaimable. */
  @Column({ type: 'timestamptz', name: 'claimed_at', nullable: true })
  claimedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;
}
