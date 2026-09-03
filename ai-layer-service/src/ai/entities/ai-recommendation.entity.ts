import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AiAutonomyLevel } from './ai-governance-policy.entity';

export enum AiRecommendationSourceModule {
  SCHEDULING = 'scheduling',
  FORECASTING = 'forecasting',
  INTRADAY = 'intraday',
}

export enum AiRecommendationStatus {
  SUGGESTED = 'suggested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  AUTO_EXECUTED = 'auto_executed',
}

/**
 * §2.1's `AIRecommendation` + §2.2 rules 1/2. `requiresHumanApproval` is
 * resolved from `AIGovernancePolicy` once, at creation, by
 * `AiGovernancePolicyResolverService` - and stored here, never recomputed
 * live from the policy table at decision time (§2.2 rule 1: a tenant
 * tightening governance mid-flight must not retroactively change what an
 * already-created recommendation requires). `supportingDataJson` is
 * `nullable: false` at the schema level (§2.2 rule 2) - not an application
 * convention a caller could bypass.
 *
 * `orgUnitId` (Phase 5, docs/adr/0125) is nullable - §6.1 names
 * `pendingRecommendations(orgUnitId)` as a real query parameter, but not
 * every `source_module` can actually supply one at creation time (Module
 * 05's own `ReallocationAction` has no `org_unit_id` column at all,
 * ADR-0122's own disclosed limitation propagates here) - `null` is the
 * honest value for those, not a guess.
 */
@Entity({ name: 'ai_recommendation', schema: 'ai_layer' })
export class AiRecommendation {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'org_unit_id', nullable: true })
  orgUnitId!: string | null;

  @Column('varchar', { name: 'recommendation_type' })
  recommendationType!: string;

  @Column('varchar', { name: 'source_module' })
  sourceModule!: AiRecommendationSourceModule;

  @Column('text', { name: 'rationale_text' })
  rationaleText!: string;

  @Column('jsonb', { name: 'supporting_data_json' })
  supportingDataJson!: Record<string, unknown>;

  @Column('varchar', { name: 'status', default: AiRecommendationStatus.SUGGESTED })
  status!: AiRecommendationStatus;

  @Column('boolean', { name: 'requires_human_approval' })
  requiresHumanApproval!: boolean;

  /**
   * Phase 5 (docs/adr/0123): the full autonomy level resolved at creation,
   * not just the derived `requiresHumanApproval` boolean - `suggest_only`
   * and `approve_required` both resolve to `requiresHumanApproval: true`,
   * but only `decideRecommendation` needs to tell them apart (`suggest_only`
   * never executes anything even once approved - see `AiRecommendationService`'s
   * own doc comment). Resolved once, alongside `requiresHumanApproval`,
   * for the identical "never recompute live from a policy that may have
   * changed since" reason (§2.2 rule 1).
   */
  @Column('varchar', { name: 'resolved_autonomy_level' })
  resolvedAutonomyLevel!: AiAutonomyLevel;

  @Column('uuid', { name: 'decided_by', nullable: true })
  decidedBy!: string | null;

  @Column('uuid', { name: 'ai_interaction_id' })
  aiInteractionId!: string;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'decided_at', nullable: true })
  decidedAt!: Date | null;

  /**
   * Phase 9 (docs/adr/0133): `detectSuspiciousRationalePhrases`'s own
   * output over the generating interaction's `outputText` at creation time -
   * a disclosed, incomplete heuristic (see that function's own doc
   * comment), not a claim that an empty array means the rationale is
   * trustworthy. Surfaced to the human reviewer via GraphQL; a non-empty
   * array also forces `requiresHumanApproval: true` regardless of the
   * resolved autonomy level (see `AiRecommendationService.createFromInteraction`).
   */
  @Column('jsonb', { name: 'suspicious_language_flags', default: () => "'[]'" })
  suspiciousLanguageFlags!: string[];
}
