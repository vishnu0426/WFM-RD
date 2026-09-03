import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { FieldMapping } from '../integrations/entities/field-mapping.entity';
import { SyncJob } from '../integrations/entities/sync-job.entity';
import { WebhookSubscription } from '../integrations/entities/webhook-subscription.entity';
import { WebhookDelivery } from '../integrations/entities/webhook-delivery.entity';
import { ProviderRateLimitConfig } from '../integrations/entities/provider-rate-limit-config.entity';
import { FieldAuthorityPolicy } from '../integrations/entities/field-authority-policy.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's own
 * `src/database/entities.ts`.
 */
export const entities = [
  IntegrationConnector,
  FieldMapping,
  SyncJob,
  WebhookSubscription,
  WebhookDelivery,
  ProviderRateLimitConfig,
  FieldAuthorityPolicy,
];

export {
  IntegrationConnector,
  FieldMapping,
  SyncJob,
  WebhookSubscription,
  WebhookDelivery,
  ProviderRateLimitConfig,
  FieldAuthorityPolicy,
};
