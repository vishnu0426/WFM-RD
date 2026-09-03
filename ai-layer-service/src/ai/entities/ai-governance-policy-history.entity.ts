import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AiAutonomyLevel } from './ai-governance-policy.entity';

/**
 * ADR-0132 (SCD Type 2, own copy of Module 02's `OrgUnitHistory`/
 * `EmployeeHistory` pattern, ADR-0009). One row per version of an
 * `AiGovernancePolicy`, written by the `ai_layer.fn_ai_governance_policy_history_track`
 * trigger on every INSERT and on any UPDATE that changes `autonomyLevel`/
 * `riskThresholdConfig` - never by application code. `agno_ai_app` has
 * INSERT + a column-scoped `UPDATE (validTo)` grant only, no DELETE.
 */
@Entity({ schema: 'ai_layer', name: 'ai_governance_policy_history' })
@Index('idx_ai_governance_policy_history_tenant_policy', ['tenantId', 'governancePolicyId', 'validFrom'])
export class AiGovernancePolicyHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'governance_policy_id' })
  governancePolicyId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'varchar', length: 60, name: 'action_type' })
  actionType!: string;

  @Column({ type: 'varchar', length: 30, name: 'autonomy_level' })
  autonomyLevel!: AiAutonomyLevel;

  @Column({ type: 'jsonb', name: 'risk_threshold_config' })
  riskThresholdConfig!: Record<string, unknown>;

  @Column({ type: 'uuid', name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
