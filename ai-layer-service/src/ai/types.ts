import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';

registerEnumType(AiInteractionType, {
  name: 'AiInteractionType',
  description:
    "§2.1's fixed interaction-type vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

/**
 * §6.1's `AIInteraction` GraphQL type (id, interactionType, outputText,
 * confidenceIndicator, supportingData, degradedMode). `supportingData` maps
 * onto the entity's `outputStructured` column - the spec names it
 * `supportingData` at the API surface; the schema column name
 * (`output_structured`) instead emphasizes "this is what the model
 * produced," which is the more precise name for what the column actually
 * holds (§2.1's own literal column list).
 *
 * `confidenceIndicator` is ALWAYS included whenever this type is returned -
 * §2.2 rule 4: "never hidden or only exposed via an API a client happens to
 * read." There is no way to query `outputText` without it.
 */
@ObjectType('AIInteraction', {
  description:
    'One record of the query router translating real structured data into a natural-language explanation or answer (§2.1). Produced by explainSchedule/explainForecast/explainReallocation/rootCauseAnalysis/askQuestion - never mutated after creation.',
})
export class AiInteractionResult {
  @Field(() => ID, {
    description: 'Stable identifier for this interaction, referenced by createReallocationRecommendation.',
  })
  id!: string;

  @Field(() => AiInteractionType, { description: 'Which query-router operation produced this interaction.' })
  interactionType!: AiInteractionType;

  @Field(() => String, {
    nullable: true,
    description: "The model's natural-language output. Null when degradedMode is true - never a fabricated summary.",
  })
  outputText!: string | null;

  @Field(() => Number, {
    nullable: true,
    description:
      '0-1, half self-reported by the model and half a mechanical groundedness check against the real input data (§0.5). Null when degradedMode is true.',
  })
  confidenceIndicator!: number | null;

  @Field(() => Object, {
    nullable: true,
    description:
      'Structured JSON the model produced alongside outputText (topConstraints/tradeOffs) - null when degradedMode is true.',
  })
  supportingData!: Record<string, unknown> | null;

  @Field(() => Boolean, {
    description:
      'True when the LLM call failed or no provider is configured - outputText/confidenceIndicator are null in that case (§4).',
  })
  degradedMode!: boolean;

  @Field(() => String, {
    description:
      'Provider and model identifier plus prompt-template version, e.g. "anthropic:claude-...@schedule-explanation-v1".',
  })
  modelUsed!: string;

  @Field(() => Date, { description: 'When this interaction was generated.' })
  createdAt!: Date;
}

export function toAiInteractionResult(interaction: AiInteraction): AiInteractionResult {
  return {
    id: interaction.id,
    interactionType: interaction.interactionType,
    outputText: interaction.outputText,
    confidenceIndicator: interaction.confidenceIndicator === null ? null : Number(interaction.confidenceIndicator),
    supportingData: interaction.outputStructured,
    degradedMode: interaction.degradedMode,
    modelUsed: interaction.modelUsed,
    createdAt: interaction.createdAt,
  };
}
