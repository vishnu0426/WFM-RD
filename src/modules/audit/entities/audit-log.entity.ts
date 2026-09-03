import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { AuditActorType } from './audit-actor-type.enum';

/**
 * ADR-0005: table is PARTITION BY RANGE (created_at) at the DB level (see
 * the Phase 1 migration - not representable via TypeORM decorators). The
 * primary key is composite (id, created_at) because Postgres requires the
 * partition key in every unique index on a partitioned table; global
 * uniqueness of `id` relies on UUIDv4 generation, not a DB constraint.
 *
 * Append-only (§2.2 rule 2): agno_app has no UPDATE/DELETE grant on this
 * table (enforced in the migration's GRANT statements), and this entity/
 * repository must never be used through anything but INSERT + SELECT.
 */
@Entity({ schema: 'core', name: 'audit_log' })
@Index('idx_audit_log_tenant_id_created_at', ['tenantId', 'createdAt'])
@Index('idx_audit_log_tenant_id_actor_id', ['tenantId', 'actorId'])
@Index('idx_audit_log_tenant_id_resource', ['tenantId', 'resourceType', 'resourceId'])
export class AuditLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @PrimaryColumn({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 20, name: 'actor_type' })
  actorType!: AuditActorType;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 100, name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'uuid', name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'jsonb', name: 'before_state', nullable: true })
  beforeState!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', name: 'after_state', nullable: true })
  afterState!: Record<string, unknown> | null;

  /** REQUIRED (NOT NULL enforced by CHECK) when actorType = ai_agent. */
  @Column({ type: 'jsonb', name: 'ai_rationale', nullable: true })
  aiRationale!: Record<string, unknown> | null;
}
