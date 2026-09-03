import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID, randomBytes } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { VaultClientService } from '../vault/vault-client.service';
import { WebhookSubscription, WebhookSubscriptionStatus } from '../integrations/entities/webhook-subscription.entity';
import { WebhookSubscriptionNotFoundError } from './errors/webhook-subscription-not-found.error';

export interface CreateWebhookSubscriptionInput {
  eventTypes: string[];
  targetUrl: string;
}

export interface CreateWebhookSubscriptionResult {
  subscription: WebhookSubscription;
  /** The raw HMAC secret - returned exactly once, from this call only. Every subsequent read of this subscription (GraphQL query, dispatcher) goes through Vault via `secretReference`, never this table. */
  secret: string;
}

export const FAILING_THRESHOLD = 5;
export const DISABLED_THRESHOLD = 20;

/**
 * §3.1's `createWebhookSubscription` (§7 Phase 7). §2.2 rule 2/ADR-0134's
 * discipline extended to this table: unlike Module 01's own webhook
 * framework (ADR-0046), which stores the HMAC secret **plaintext** in
 * `core.webhook_subscriptions` (that module's own flagged gap - "a
 * production deployment should encrypt this column at rest"), this module
 * already has a Vault-reference convention for every other credential it
 * holds, so this secret goes through the identical path
 * (`IntegrationConnectorsService.prepareDirectCredentialConnector`'s own
 * precedent) rather than repeating Module 01's plaintext-column gap in a
 * module whose own §0 framing calls out "the platform's largest external-
 * attack-surface concentration." See the Phase 7 design doc.
 */
@Injectable()
export class WebhookSubscriptionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly vault: VaultClientService,
  ) {}

  async create(tenantId: string, input: CreateWebhookSubscriptionInput): Promise<CreateWebhookSubscriptionResult> {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const secretReference = this.secretVaultPath(tenantId, id);
    await this.vault.write(secretReference, { secret });

    const subscription = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(WebhookSubscription, {
        id,
        tenantId,
        eventTypes: input.eventTypes,
        targetUrl: input.targetUrl,
        secretReference,
        status: WebhookSubscriptionStatus.ACTIVE,
        consecutiveFailureCount: 0,
      }),
    );

    return { subscription, secret };
  }

  async findAllForTenant(tenantId: string): Promise<WebhookSubscription[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(WebhookSubscription).find({ where: { tenantId }, order: { id: 'ASC' } }),
    );
  }

  async findByIdForTenant(tenantId: string, subscriptionId: string): Promise<WebhookSubscription> {
    const subscription = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(WebhookSubscription, { where: { tenantId, id: subscriptionId } }),
    );
    if (!subscription) {
      throw new WebhookSubscriptionNotFoundError(subscriptionId);
    }
    return subscription;
  }

  /**
   * §7 Phase 7's auto-disable escalation, called by
   * `WebhookDeliveryDispatcherService` after each real delivery attempt -
   * `FAILING_THRESHOLD` flags a subscription for operator visibility
   * (still attempted), `DISABLED_THRESHOLD` stops the dispatcher from
   * attempting it at all (`WebhookFanoutService`'s own `status !=
   * disabled` filter). A success resets the counter and self-heals a
   * `failing` subscription back to `active` - a transient outage on the
   * receiver's end shouldn't permanently disable it, only a sustained one.
   */
  async recordDeliveryOutcome(tenantId: string, subscriptionId: string, delivered: boolean): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const subscription = await manager.findOne(WebhookSubscription, { where: { tenantId, id: subscriptionId } });
      if (!subscription) return;

      if (delivered) {
        if (subscription.consecutiveFailureCount === 0 && subscription.status === WebhookSubscriptionStatus.ACTIVE) {
          return;
        }
        await manager.update(
          WebhookSubscription,
          { id: subscriptionId, tenantId },
          { consecutiveFailureCount: 0, status: WebhookSubscriptionStatus.ACTIVE },
        );
        return;
      }

      const consecutiveFailureCount = subscription.consecutiveFailureCount + 1;
      let status = subscription.status;
      if (consecutiveFailureCount >= FAILING_THRESHOLD) {
        status = WebhookSubscriptionStatus.FAILING;
      }
      if (consecutiveFailureCount >= DISABLED_THRESHOLD) {
        status = WebhookSubscriptionStatus.DISABLED;
      }
      await manager.update(WebhookSubscription, { id: subscriptionId, tenantId }, { consecutiveFailureCount, status });
    });
  }

  private secretVaultPath(tenantId: string, subscriptionId: string): string {
    return `integration-hub/${tenantId}/webhook/${subscriptionId}/secret`;
  }
}
