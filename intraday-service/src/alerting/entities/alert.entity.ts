import { Column, Entity, PrimaryColumn } from 'typeorm';

export type AlertSeverity = 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'suppressed' | 'resolved';

/**
 * §2.1/§5a, ADR-0069. `last_triggered_at`/`escalated_at`/`resolved_at`
 * extend §2.1's literal field list - necessary for the dedup/escalation/
 * auto-resolution pipeline to function, not arbitrary additions (design
 * doc explicit assumption 1). Not partitioned (unlike `AdherenceEvent`) -
 * §3.4's partitioning ask was specific to the high-volume event log, not
 * this comparatively low-volume table.
 */
@Entity({ name: 'alert', schema: 'intraday' })
export class Alert {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  /** `'service_level_breach'` only this phase - see design doc assumption 6. */
  @Column('varchar', { name: 'alert_type' })
  alertType!: string;

  @Column('varchar')
  severity!: AlertSeverity;

  /** Always `null` today - no upstream payload in this module carries `org_unit_id` (design doc assumption 5). */
  @Column('uuid', { name: 'org_unit_id', nullable: true })
  orgUnitId!: string | null;

  @Column('uuid', { name: 'queue_id', nullable: true })
  queueId!: string | null;

  @Column('varchar')
  status!: AlertStatus;

  @Column('uuid', { name: 'dedup_group_id' })
  dedupGroupId!: string;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'last_triggered_at' })
  lastTriggeredAt!: Date;

  @Column('timestamptz', { name: 'escalated_at', nullable: true })
  escalatedAt!: Date | null;

  @Column('uuid', { name: 'acknowledged_by', nullable: true })
  acknowledgedBy!: string | null;

  @Column('timestamptz', { name: 'acknowledged_at', nullable: true })
  acknowledgedAt!: Date | null;

  @Column('timestamptz', { name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;
}
