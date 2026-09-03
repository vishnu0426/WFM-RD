import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { AiAutonomyLevel, AiGovernancePolicy } from './entities/ai-governance-policy.entity';
import { AiGovernancePolicyHistory } from './entities/ai-governance-policy-history.entity';

registerEnumType(AiAutonomyLevel, {
  name: 'AiAutonomyLevel',
  description: "§3's fixed autonomy-level vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

@ObjectType('AIGovernancePolicy', {
  description:
    "A tenant's own autonomy-level configuration for one action_type (§3), resolved by three-tier order (exact match -> tenant's own 'default' row -> the platform default suggest_only) whenever a recommendation is created.",
})
export class AiGovernancePolicyResult {
  @Field(() => String, {
    description:
      'e.g. "reallocation", or the "default" sentinel for this tenant\'s own broader/category-level row (ADR-0114).',
  })
  actionType!: string;

  @Field(() => AiAutonomyLevel, {
    description:
      'suggest_only / approve_required / auto_execute_low_risk - never a more permissive level than what was explicitly configured.',
  })
  autonomyLevel!: AiAutonomyLevel;

  @Field(() => Object, {
    description:
      'Only evaluated when autonomyLevel is auto_execute_low_risk: maxAffectedEmployees/minConfidenceIndicator are the only two real, evaluated criteria (ADR-0124).',
  })
  riskThresholdConfig!: Record<string, unknown>;

  @Field(() => Date)
  updatedAt!: Date;
}

export function toAiGovernancePolicyResult(policy: AiGovernancePolicy): AiGovernancePolicyResult {
  return {
    actionType: policy.actionType,
    autonomyLevel: policy.autonomyLevel,
    riskThresholdConfig: policy.riskThresholdConfig,
    updatedAt: policy.updatedAt,
  };
}

/** ADR-0132 (SCD Type 2) - one past or current version of an `AIGovernancePolicy`. `validTo: null` marks the currently active version. */
@ObjectType('AIGovernancePolicyHistoryEntry', {
  description:
    'One version of an AIGovernancePolicy, written by a database trigger on every real autonomy_level/risk_threshold_config change - never by application code (ADR-0132, SCD Type 2). Newest first; validTo: null marks the currently active version.',
})
export class AiGovernancePolicyHistoryResult {
  @Field(() => String)
  actionType!: string;

  @Field(() => AiAutonomyLevel)
  autonomyLevel!: AiAutonomyLevel;

  @Field(() => Object)
  riskThresholdConfig!: Record<string, unknown>;

  @Field(() => Date, { description: 'When this version became active.' })
  validFrom!: Date;

  @Field(() => Date, {
    nullable: true,
    description: 'When this version was superseded - null for the currently active version.',
  })
  validTo!: Date | null;

  @Field(() => ID, {
    nullable: true,
    description: "The user who made this change, from the verified access token's own sub claim.",
  })
  updatedBy!: string | null;
}

export function toAiGovernancePolicyHistoryResult(entry: AiGovernancePolicyHistory): AiGovernancePolicyHistoryResult {
  return {
    actionType: entry.actionType,
    autonomyLevel: entry.autonomyLevel,
    riskThresholdConfig: entry.riskThresholdConfig,
    validFrom: entry.validFrom,
    validTo: entry.validTo,
    updatedBy: entry.updatedBy,
  };
}
