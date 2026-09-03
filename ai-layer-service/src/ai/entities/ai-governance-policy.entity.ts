import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AiAutonomyLevel {
  SUGGEST_ONLY = 'suggest_only',
  APPROVE_REQUIRED = 'approve_required',
  AUTO_EXECUTE_LOW_RISK = 'auto_execute_low_risk',
}

/**
 * §2.1's `AIGovernancePolicy` + §3's resolution order. `actionType` uses the
 * sentinel `'default'` for a tenant's own broader/category-level row (§3:
 * "tenant-specific row for the exact action_type -> tenant-specific row for
 * a broader/default action_type category -> platform default"), resolved by
 * `AiGovernancePolicyResolverService`. No row at all (any tenant, any
 * action_type) falls through to the hardcoded platform default,
 * `suggest_only` - the safest level, never a more permissive one, for an
 * action_type nobody has configured. `riskThresholdConfig` is §3's concrete
 * `auto_execute_low_risk` gate (e.g. `{"maxAffectedEmployees": 5,
 * "maxOvertimeCostImpact": 0, "minConfidenceIndicator": 0.8}`) - evaluated
 * by `RiskThresholdEvaluatorService`, not a vague label.
 */
@Entity({ name: 'ai_governance_policy', schema: 'ai_layer' })
export class AiGovernancePolicy {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'action_type' })
  actionType!: string;

  @Column('varchar', { name: 'autonomy_level' })
  autonomyLevel!: AiAutonomyLevel;

  @Column('jsonb', { name: 'risk_threshold_config', default: {} })
  riskThresholdConfig!: Record<string, unknown>;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;

  /**
   * Phase 5 (docs/adr/0125): made nullable - no real user-identity
   * resolution exists anywhere in this module yet (the same disclosed gap
   * `explainSchedule`'s own `userId: null` already carries), and
   * `updateGovernancePolicy` has no real caller identity to record
   * honestly. `null` here, not a fabricated id.
   */
  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
