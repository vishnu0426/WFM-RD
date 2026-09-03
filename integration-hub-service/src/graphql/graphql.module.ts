import { join } from 'path';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLFormattedError } from 'graphql';
import { DomainError } from '../common/errors/domain-error';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { IntegrationConnectorsModule } from '../connectors/integration-connectors.module';
import { SyncModule } from '../sync/sync.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { JsonScalar } from './json.scalar';
import { IntegrationConnectorResolver } from '../connectors/graphql/integration-connector.resolver';
import { FieldMappingResolver } from '../connectors/graphql/field-mapping.resolver';
import { SyncJobHistoryResolver } from '../connectors/graphql/sync-job-history.resolver';
import { FieldAuthorityPolicyResolver } from '../connectors/graphql/field-authority-policy.resolver';
import { ConnectorHealthResolver } from '../connectors/graphql/connector-health.resolver';
import { ReasonCodeResolver } from '../connectors/graphql/reason-code.resolver';
import { DataSourceGroupResolver } from '../connectors/graphql/data-source-group.resolver';

/** GraphQL-side counterpart to `DomainErrorFilter` (REST) - own copy of every other service's own `formatGraphQLError`. */
function formatGraphQLError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original =
    error instanceof Error && 'originalError' in error ? (error as { originalError?: unknown }).originalError : error;
  if (original instanceof DomainError) {
    return {
      ...formattedError,
      message: original.message,
      extensions: { code: original.code },
    };
  }
  return formattedError;
}

/**
 * Phase 2 (§3.1): `createConnector`/`connectors`. Phase 3 added
 * `updateFieldMapping`/`syncJobHistory`. Phase 4 adds
 * `createFieldAuthorityPolicy`/`fieldAuthorityPolicies`
 * (`FieldAuthorityPolicyResolver`) - a real upsert, same parity decision as
 * `updateFieldMapping`. Phase 7 adds the remaining §3.1 surface:
 * `triggerManualSync` as a GraphQL mutation (`SyncJobHistoryResolver` - it
 * already existed as REST, §3.2, unchanged), and
 * `createWebhookSubscription`/`testWebhook`/`webhookDeliveries`/
 * `webhookSubscriptions` (`WebhookSubscriptionResolver`, `WebhooksModule`).
 * Phase 8 (ADR-0145) adds real RBAC (`AuthModule`) - `createConnector`/
 * `createWebhookSubscription` are the two mutations gated
 * (`AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`), the
 * same "gate the specific credential-adjacent risk, not everything"
 * scoping ai-layer-service's own ADR-0130 applied; every other query/
 * mutation here remains on the header-trust placeholder (ADR-0014). Phase
 * 8 also adds the connector health dashboard (`connectorHealth`/
 * `connectorsHealth`, `ConnectorHealthResolver`) - an aggregate read over
 * data every prior phase already made real, not a new subsystem.
 *
 * `MetricsModule` imported directly, and `AccessTokenGuard`/`PermissionsGuard`/
 * `TenantTokenMatchGuard` re-listed in `providers` alongside importing
 * `AuthModule` - `IntegrationConnectorResolver`'s own `@UseGuards(...)`
 * resolves a guard through *this* module's injector, not the module that
 * originally provided it, and that fresh instance's own `MetricsService`
 * dependency needs to be visible here too (a real boot failure caught
 * live, the same DI quirk `WebhooksModule`'s own doc comment documents).
 *
 * ADR-0166 closes the scope boundary the paragraph above disclosed:
 * `connectors`/`syncJobHistory`/`triggerManualSync`/`updateFieldMapping`/
 * `fieldAuthorityPolicies`/`createFieldAuthorityPolicy`/`connectorHealth`/
 * `connectorsHealth`/`webhookSubscriptions`/`testWebhook`/`webhookDeliveries`
 * are now all real-RBAC-gated too (`integration_connector:read`/`:write`,
 * `webhook_subscription:read`/`:write`) - no query or mutation in this
 * schema is left on the header-trust placeholder anymore.
 */
@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      formatError: formatGraphQLError,
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    TenantContextModule,
    MetricsModule,
    IntegrationConnectorsModule,
    SyncModule,
    WebhooksModule,
    AuthModule,
  ],
  providers: [
    JsonScalar,
    IntegrationConnectorResolver,
    FieldMappingResolver,
    SyncJobHistoryResolver,
    FieldAuthorityPolicyResolver,
    ConnectorHealthResolver,
    ReasonCodeResolver,
    DataSourceGroupResolver,
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
})
export class IntegrationHubGraphQLModule {}
