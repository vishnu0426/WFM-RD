import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { WebhookSubscriptionsService } from '../webhook-subscriptions.service';
import { WebhookDeliveriesService } from '../webhook-deliveries.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import {
  CreateWebhookSubscriptionResultType,
  WebhookDeliveryResult,
  WebhookSubscriptionResult,
  toCreateWebhookSubscriptionResultType,
  toWebhookDeliveryResult,
  toWebhookSubscriptionResult,
} from './types';

const DEFAULT_DELIVERY_LIMIT = 20;
const MAX_DELIVERY_LIMIT = 200;
const TEST_EVENT_TYPE = 'webhook.test';

/**
 * §3.1's remaining webhook mutations/queries (§7 Phase 7):
 * `createWebhookSubscription`, `testWebhook`, `webhookDeliveries` -
 * `IntegrationHubGraphQLModule`'s own doc comment named these three as
 * deferred until this phase. `webhookSubscriptions` (a plain list query)
 * is one addition beyond that literal set - every other entity in this
 * schema pairs its create mutation with a list query
 * (`connectors`/`syncJobHistory`/`fieldAuthorityPolicies`), and a tenant
 * has no other way to see what they've already configured (the secret
 * itself is deliberately never re-exposed here, only at creation time) -
 * flagged explicitly, matching this platform's "disclose an addition
 * beyond literal spec text" convention rather than silently including it.
 *
 * ADR-0166 extends real RBAC (`webhook_subscription:read`/`:write`) to the
 * rest of this resolver - `createWebhookSubscription` was the only gated
 * mutation here until now (ADR-0145's own disclosed scope boundary,
 * `graphql.module.ts`'s doc comment).
 */
@Resolver(() => WebhookSubscriptionResult)
export class WebhookSubscriptionResolver {
  constructor(
    private readonly subscriptions: WebhookSubscriptionsService,
    private readonly deliveries: WebhookDeliveriesService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('webhook_subscription:read')
  @Query(() => [WebhookSubscriptionResult], { name: 'webhookSubscriptions' })
  async webhookSubscriptions(): Promise<WebhookSubscriptionResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.subscriptions.findAllForTenant(tenantId);
    return rows.map(toWebhookSubscriptionResult);
  }

  /**
   * §7 Phase 8 (ADR-0145): gated alongside `createConnector` - a
   * subscription's `targetUrl` is admin-supplied and its secret grants
   * whoever holds it the ability to forge a signed delivery this module
   * would treat as genuine on the receiving end, the same credential-
   * adjacent risk class as a connector's own Vault-referenced secret.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('webhook_subscription:write')
  @Mutation(() => CreateWebhookSubscriptionResultType)
  async createWebhookSubscription(
    @Args('eventTypes', { type: () => [String] }) eventTypes: string[],
    @Args('targetUrl') targetUrl: string,
  ): Promise<CreateWebhookSubscriptionResultType> {
    const tenantId = this.tenantContext.requireTenantId();
    const result = await this.subscriptions.create(tenantId, { eventTypes, targetUrl });
    return toCreateWebhookSubscriptionResultType(result);
  }

  /**
   * §3.1's `testWebhook` - enqueues a real synthetic delivery through the same dispatcher every other event uses, so a tenant admin can verify their receiver/signature-verification code actually works before relying on it - not a direct, un-queued HTTP call that would bypass the retry/auto-disable machinery the real delivery path has.
   *
   * Gated `:write` (not `:read`) - it creates a real, real-side-effect delivery attempt, not a pure read.
   */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('webhook_subscription:write')
  @Mutation(() => WebhookDeliveryResult)
  async testWebhook(
    @Args('subscriptionId', { type: () => ID }) subscriptionId: string,
  ): Promise<WebhookDeliveryResult> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.subscriptions.findByIdForTenant(tenantId, subscriptionId);
    const payload = {
      message: 'This is a test delivery from Agno WFM Integration Hub.',
      triggeredAt: new Date().toISOString(),
    };
    await this.deliveries.enqueue(tenantId, subscriptionId, TEST_EVENT_TYPE, payload);
    const [latest] = await this.deliveries.findAllForSubscription(tenantId, subscriptionId, 1);
    return toWebhookDeliveryResult(latest);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('webhook_subscription:read')
  @Query(() => [WebhookDeliveryResult], { name: 'webhookDeliveries' })
  async webhookDeliveries(
    @Args('subscriptionId', { type: () => ID }) subscriptionId: string,
    @Args('limit', { type: () => Number, nullable: true }) limit?: number,
  ): Promise<WebhookDeliveryResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const boundedLimit = Math.min(limit ?? DEFAULT_DELIVERY_LIMIT, MAX_DELIVERY_LIMIT);
    const rows = await this.deliveries.findAllForSubscription(tenantId, subscriptionId, boundedLimit);
    return rows.map(toWebhookDeliveryResult);
  }
}
