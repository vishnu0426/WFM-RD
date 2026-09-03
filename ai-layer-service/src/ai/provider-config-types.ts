import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { AiLlmProvider } from './entities/ai-provider-config.entity';
import { AiProviderConfigHistory } from './entities/ai-provider-config-history.entity';

registerEnumType(AiLlmProvider, {
  name: 'AiLlmProvider',
  description:
    "docs/adr/0117's BYOK provider vocabulary - the same enum this module's schema CHECK constraint enforces.",
});

/**
 * `configureAiProvider`'s return shape - deliberately has no `apiKey`
 * field at all, not even a redacted one. Same "write-only after creation"
 * posture as `oauth_clients`' signing secret (ADR-0046): the only way to
 * know a tenant's key is themselves, at the moment they set it.
 */
@ObjectType('AiProviderConfigSummary', {
  description:
    "A tenant's own BYOK LLM provider configuration - never includes the API key, which is write-only after creation (the oauth_clients signing-secret precedent, ADR-0046).",
})
export class AiProviderConfigSummaryResult {
  @Field(() => AiLlmProvider, {
    description:
      'anthropic / openai / gemini (cloud, apiKey required) or ollama (self-hosted, baseUrl required instead).',
  })
  provider!: AiLlmProvider;

  @Field(() => String, {
    description: "The tenant's own configured model identifier, used verbatim - never hardcoded by this service.",
  })
  model!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'Only ever non-null for ollama - a self-hosted provider has no fixed platform endpoint (ADR-0129). Not a secret, safe to echo back.',
  })
  baseUrl!: string | null;

  @Field(() => Date)
  updatedAt!: Date;
}

/** ADR-0132 (SCD Type 2) - one past or current version of an `AiProviderConfig`. `validTo: null` marks the currently active version. Never carries the key, same posture as `AiProviderConfigSummaryResult`. */
@ObjectType('AiProviderConfigHistoryEntry', {
  description:
    "One version of an AiProviderConfig, written by a database trigger on every configure() call - never by application code (ADR-0132, SCD Type 2). Versions on EVERY update, not just a tracked-column change, since the encrypted key's random IV makes 'did the key actually change' unobservable by comparing columns. The key itself is never copied into this history at all.",
})
export class AiProviderConfigHistoryResult {
  @Field(() => AiLlmProvider)
  provider!: AiLlmProvider;

  @Field(() => String)
  model!: string;

  @Field(() => String, { nullable: true })
  baseUrl!: string | null;

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

export function toAiProviderConfigHistoryResult(entry: AiProviderConfigHistory): AiProviderConfigHistoryResult {
  return {
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl,
    validFrom: entry.validFrom,
    validTo: entry.validTo,
    updatedBy: entry.updatedBy,
  };
}
