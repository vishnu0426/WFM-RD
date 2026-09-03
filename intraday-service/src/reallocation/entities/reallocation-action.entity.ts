import { Column, Entity, PrimaryColumn } from 'typeorm';

export type ReallocationTriggeredBy = 'system_recommendation' | 'supervisor_manual';
export type ReallocationStatus = 'suggested' | 'approved' | 'rejected' | 'auto_executed' | 'executed';

/** §2.1, ADR-0070. `ai_rationale` is nullable at the type level; the migration's CHECK constraint enforces §2.2 rule 3. */
@Entity({ name: 'reallocation_action', schema: 'intraday' })
export class ReallocationAction {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'triggered_by' })
  triggeredBy!: ReallocationTriggeredBy;

  @Column('uuid', { name: 'from_queue_id' })
  fromQueueId!: string;

  @Column('uuid', { name: 'to_queue_id' })
  toQueueId!: string;

  @Column('uuid', { name: 'affected_employee_ids', array: true })
  affectedEmployeeIds!: string[];

  @Column('varchar')
  reason!: string;

  @Column('varchar')
  status!: ReallocationStatus;

  /** Deterministic, real-metrics-citing object (Module 01's own `AuditLog.aiRationale` convention) - never a real LLM/ML call. */
  @Column('jsonb', { name: 'ai_rationale', nullable: true })
  aiRationale!: Record<string, unknown> | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'executed_at', nullable: true })
  executedAt!: Date | null;
}
