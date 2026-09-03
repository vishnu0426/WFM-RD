import { AiInteraction } from '../ai/entities/ai-interaction.entity';
import { AiRecommendation } from '../ai/entities/ai-recommendation.entity';
import { AiGovernancePolicy } from '../ai/entities/ai-governance-policy.entity';
import { AiGovernancePolicyHistory } from '../ai/entities/ai-governance-policy-history.entity';
import { AiProviderConfig } from '../ai/entities/ai-provider-config.entity';
import { AiProviderConfigHistory } from '../ai/entities/ai-provider-config-history.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's own
 * `src/database/entities.ts` in this platform.
 */
export const entities = [
  AiInteraction,
  AiRecommendation,
  AiGovernancePolicy,
  AiGovernancePolicyHistory,
  AiProviderConfig,
  AiProviderConfigHistory,
];

export {
  AiInteraction,
  AiRecommendation,
  AiGovernancePolicy,
  AiGovernancePolicyHistory,
  AiProviderConfig,
  AiProviderConfigHistory,
};
