import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * ADR-0019: the transactional outbox for §4's NATS events. Written in the
 * *same* database transaction as the entity change it describes (see
 * `EmployeesRepository.createWithOutboxEvent` et al.) - so "the employee
 * history row exists but the event was never queued" (or vice versa) is not
 * a reachable state, regardless of whether NATS itself is reachable at
 * write time. `OutboxPublisherService` is the only writer of
 * `publishedAt`/`attempts`/`lastError`, on a separate, independent schedule.
 */
@Entity({ schema: 'org', name: 'outbox_events' })
@Index('idx_outbox_events_tenant_id_published_at', ['tenantId', 'publishedAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** e.g. `agno.org.employee.changed.v1` - see `src/modules/eventing/subjects.ts`. */
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
