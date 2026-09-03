import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { AuditActorType } from './audit-actor-type.enum';

/**
 * ADR-0042: the durable backing store for `AuditEventBatcherService`'s
 * queue - replaces what used to be a plain in-memory array. `enqueue`
 * inserts a row here synchronously (well, the insert itself is awaited
 * internally and logged on failure, but the caller doesn't wait on it - see
 * that service's doc comment); the flush tick reads a batch, writes each to
 * `audit_log` via `AuditLogRepository.record`, and deletes the row on
 * success. A process restart between those two steps loses nothing - the
 * row is still sitting in Postgres for the next tick (in this process or a
 * replacement one) to pick up.
 */
@Entity({ schema: 'core', name: 'pending_audit_events' })
@Index('idx_pending_audit_events_tenant_id_created_at', ['tenantId', 'createdAt'])
export class PendingAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 50, name: 'actor_type' })
  actorType!: AuditActorType;

  @Column({ type: 'varchar', length: 255 })
  action!: string;

  @Column({ type: 'varchar', length: 255, name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'varchar', length: 255, name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'jsonb', name: 'before_state', nullable: true })
  beforeState!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', name: 'after_state', nullable: true })
  afterState!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', name: 'ai_rationale', nullable: true })
  aiRationale!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError!: string | null;
}
