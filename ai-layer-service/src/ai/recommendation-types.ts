import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  AiRecommendation,
  AiRecommendationSourceModule,
  AiRecommendationStatus,
} from './entities/ai-recommendation.entity';

registerEnumType(AiRecommendationSourceModule, {
  name: 'AiRecommendationSourceModule',
  description: "§2.1's fixed source-module vocabulary - the same enum this module's schema CHECK constraint enforces.",
});
registerEnumType(AiRecommendationStatus, {
  name: 'AiRecommendationStatus',
  description: "§2.1's fixed status vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

/** `decideRecommendation`'s own input vocabulary - deliberately narrower than `AiRecommendationStatus` (a caller decides `approved`/`rejected` only; `auto_executed` is never a human decision). */
export enum AiRecommendationDecision {
  APPROVED = 'approved',
  REJECTED = 'rejected',
}
registerEnumType(AiRecommendationDecision, {
  name: 'AiRecommendationDecision',
  description:
    "`decideRecommendation`'s own input vocabulary - a human can only approve or reject, never mark something auto_executed.",
});

/** §2.1's `AIRecommendation` GraphQL type - the governed, human-in-the-loop-decidable output of createReallocationRecommendation, decided via decideRecommendation. */
@ObjectType('AIRecommendation', {
  description:
    'An AI-generated recommendation subject to §3 governance (autonomy-level resolution + risk-threshold evaluation) - never executed without going through decideRecommendation, unless auto_execute_low_risk already cleared it at creation time.',
})
export class AiRecommendationResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, {
    nullable: true,
    description:
      'Null for every reallocation-sourced recommendation today - ReallocationAction has no org_unit_id column (a disclosed limitation, ADR-0122).',
  })
  orgUnitId!: string | null;

  @Field(() => String, {
    description: 'e.g. "reallocation" - the only recommendation_type with a real execution pathway wired (ADR-0123).',
  })
  recommendationType!: string;

  @Field(() => AiRecommendationSourceModule, { description: 'Which owning module this recommendation acts on.' })
  sourceModule!: AiRecommendationSourceModule;

  @Field(() => String, {
    description:
      "The generating AIInteraction's own outputText, stored verbatim - not sanitized, not fact-checked beyond suspiciousLanguageFlags (see that field's own description).",
  })
  rationaleText!: string;

  @Field(() => Object, {
    description:
      'A copy of the generating AIInteraction.inputContext - the real structured data this recommendation is grounded in.',
  })
  supportingData!: Record<string, unknown>;

  @Field(() => AiRecommendationStatus, {
    description: 'suggested (awaiting a human decision) / approved / rejected / auto_executed.',
  })
  status!: AiRecommendationStatus;

  @Field(() => Boolean, {
    description:
      'True unless autonomy_level resolved to auto_execute_low_risk AND every risk threshold (including suspiciousLanguageFlags) passed.',
  })
  requiresHumanApproval!: boolean;

  @Field(() => [String], {
    description:
      'A disclosed, incomplete heuristic (ADR-0131/0133) - empty does NOT mean rationaleText is trustworthy, only that no known suspicious phrase pattern (e.g. "already approved", "no review needed") matched. A non-empty array already forced requiresHumanApproval to true if it was not already.',
  })
  suspiciousLanguageFlags!: string[];

  @Field(() => ID, {
    nullable: true,
    description:
      "The deciding user's id (from the verified access token), or null for a system/auto-executed decision.",
  })
  decidedBy!: string | null;

  @Field(() => ID, { description: 'The AIInteraction this recommendation was created from.' })
  aiInteractionId!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true, description: 'Null while status is still "suggested".' })
  decidedAt!: Date | null;
}

export function toAiRecommendationResult(recommendation: AiRecommendation): AiRecommendationResult {
  return {
    id: recommendation.id,
    orgUnitId: recommendation.orgUnitId,
    recommendationType: recommendation.recommendationType,
    sourceModule: recommendation.sourceModule,
    rationaleText: recommendation.rationaleText,
    supportingData: recommendation.supportingDataJson,
    status: recommendation.status,
    requiresHumanApproval: recommendation.requiresHumanApproval,
    suspiciousLanguageFlags: recommendation.suspiciousLanguageFlags,
    decidedBy: recommendation.decidedBy,
    aiInteractionId: recommendation.aiInteractionId,
    createdAt: recommendation.createdAt,
    decidedAt: recommendation.decidedAt,
  };
}
