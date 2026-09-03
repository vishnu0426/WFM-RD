import { Module } from '@nestjs/common';
import { VaultModule } from '../vault/vault.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { IntegrationHubNatsModule } from './nats/integration-hub-nats.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookFanoutService } from './webhook-fanout.service';
import { WebhookDeliveryDispatcherService } from './webhook-delivery-dispatcher.service';
import { WebhookSubscriptionResolver } from './graphql/webhook-subscription.resolver';

/**
 * §7 Phase 7: `WebhookSubscription`/`WebhookDelivery` CRUD, the outbound
 * dispatcher (ADR-0046's shape, own copy), and the NATS publish this
 * module's own `SyncJobsService.complete()` now makes on every real
 * `SyncJob` completion - `WebhookFanoutService` is that publish's
 * immediate next step, the same "fan out right after the shared
 * completion point" wiring ADR-0046 established. Exports what
 * `SyncJobsService` needs (`WebhookFanoutService`) plus the NATS client
 * (re-exported from `IntegrationHubNatsModule`, itself `@Global`) so
 * `SyncModule` can import this module without a second, separate wiring
 * path.
 *
 * `TenantContextModule` imported directly (not just transitively through
 * `AuthModule`, which imports it but doesn't export it) - `WebhookSubscriptionResolver`
 * injects `TenantContextService` directly, not just through a re-listed
 * guard, so it needs the module in *this* module's own provider graph. A
 * real boot failure ("Nest can't resolve dependencies of the
 * WebhookSubscriptionResolver... TenantContextService... in WebhooksModule
 * context"), not a guess.
 *
 * `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard` re-listed
 * in `providers` too, same reason - `WebhookSubscriptionResolver`'s own
 * `@UseGuards(...)` resolves a guard through the *consuming* module's
 * injector, not the module that originally provided it (`AuthModule`'s own
 * doc comment).
 */
@Module({
  imports: [VaultModule, IntegrationHubNatsModule, MetricsModule, TenantContextModule, AuthModule],
  providers: [
    migratorPoolProvider,
    WebhookSubscriptionsService,
    WebhookDeliveriesService,
    WebhookFanoutService,
    WebhookDeliveryDispatcherService,
    WebhookSubscriptionResolver,
    AccessTokenGuard,
    PermissionsGuard,
    TenantTokenMatchGuard,
  ],
  exports: [WebhookSubscriptionsService, WebhookDeliveriesService, WebhookFanoutService],
})
export class WebhooksModule {}
