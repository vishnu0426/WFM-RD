import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { FieldMapping } from '../integrations/entities/field-mapping.entity';
import { SyncJob } from '../integrations/entities/sync-job.entity';
import { WebhookSubscription } from '../integrations/entities/webhook-subscription.entity';
import { WebhookDelivery } from '../integrations/entities/webhook-delivery.entity';
import { ProviderRateLimitConfig } from '../integrations/entities/provider-rate-limit-config.entity';
import { FieldAuthorityPolicy } from '../integrations/entities/field-authority-policy.entity';
import { ReasonCode } from '../integrations/entities/reason-code.entity';
import { DataSourceGroup } from '../integrations/entities/data-source-group.entity';
import { DataSourceGroupQueue } from '../integrations/entities/data-source-group-queue.entity';
import { HistoricalBackfillChunk } from '../integrations/entities/historical-backfill-chunk.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's own
 * `src/database/entities.ts`. `ReasonCode`/`DataSourceGroup`/
 * `DataSourceGroupQueue` added by Tenant Admin Integration Management WP3,
 * `HistoricalBackfillChunk` by WP5.
 */
export const entities = [
  IntegrationConnector,
  FieldMapping,
  SyncJob,
  WebhookSubscription,
  WebhookDelivery,
  ProviderRateLimitConfig,
  FieldAuthorityPolicy,
  ReasonCode,
  DataSourceGroup,
  DataSourceGroupQueue,
  HistoricalBackfillChunk,
];

export {
  IntegrationConnector,
  FieldMapping,
  SyncJob,
  WebhookSubscription,
  WebhookDelivery,
  ProviderRateLimitConfig,
  FieldAuthorityPolicy,
  ReasonCode,
  DataSourceGroup,
  DataSourceGroupQueue,
  HistoricalBackfillChunk,
};
