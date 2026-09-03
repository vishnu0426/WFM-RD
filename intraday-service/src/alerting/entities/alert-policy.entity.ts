import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §5a's "expected lunch-hour dip, don't alert" example, made into the
 * minimal shape that expresses it: a time-of-day window, optionally
 * scoped to one queue (`queueId: null` = applies to every queue).
 */
export interface SuppressionRule {
  alertType: string;
  queueId: string | null;
  startHourUtc: number;
  endHourUtc: number;
}

/**
 * §5a, ADR-0069: a small, self-contained tenant-configurable policy table
 * - not integrated with Module 01's generic `Policy` versioning system
 * (design doc explicit assumption 2, cross-module scope this phase
 * doesn't take on). No row for a tenant is a valid, expected state -
 * `AlertPolicyService` applies defaults, not a second code path.
 */
@Entity({ name: 'alert_policy', schema: 'intraday' })
export class AlertPolicy {
  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('integer', { name: 'dedup_window_minutes' })
  dedupWindowMinutes!: number;

  @Column('integer', { name: 'suppression_ack_window_minutes' })
  suppressionAckWindowMinutes!: number;

  @Column('integer', { name: 'escalation_threshold_minutes' })
  escalationThresholdMinutes!: number;

  @Column('jsonb', { name: 'suppression_rules' })
  suppressionRules!: SuppressionRule[];
}
