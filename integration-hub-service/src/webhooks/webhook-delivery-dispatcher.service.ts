import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac } from 'node:crypto';
import { VaultClientService } from '../vault/vault-client.service';
import { WebhookDeliveriesService } from './webhook-deliveries.service';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service';
import { WebhookDelivery } from '../integrations/entities/webhook-delivery.entity';
import { WebhookSubscriptionStatus } from '../integrations/entities/webhook-subscription.entity';
import { MetricsService } from '../common/metrics/metrics.service';

const BATCH_SIZE = 50;
const DELIVERY_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER = 'x-agno-webhook-signature';

/**
 * §7 Phase 7's own copy of Module 01's `WebhookDeliveryDispatcherService`
 * (ADR-0046) - a 5-second tick draining `webhook_delivery`, same
 * `t=<unix_ms>,v1=<hmac>` signing shape (over `${timestamp}.${rawBody}`,
 * not the body alone, so a receiver can reject an old replayed request by
 * checking the timestamp) this module already uses for its own outbound
 * call to Module 05 (`IntradayActivityEventClient`) - one HMAC convention
 * used consistently everywhere this module signs an outbound HTTP request.
 *
 * Reads the signing secret from Vault via `subscription.secretReference`
 * on every delivery (never cached, never persisted outside Vault) - the
 * one real deviation from Module 01's own dispatcher, which reads a
 * plaintext column. See `WebhookSubscriptionsService`'s own doc comment.
 */
@Injectable()
export class WebhookDeliveryDispatcherService {
  private readonly logger = new Logger(WebhookDeliveryDispatcherService.name);
  private ticking = false;

  constructor(
    private readonly deliveries: WebhookDeliveriesService,
    private readonly subscriptions: WebhookSubscriptionsService,
    private readonly vault: VaultClientService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(process.env.WEBHOOK_DISPATCH_CRON_EXPRESSION ?? '*/5 * * * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.drain();
    } finally {
      this.ticking = false;
    }
  }

  private async drain(): Promise<void> {
    const batch = await this.deliveries.findPendingBatch(BATCH_SIZE);
    for (const delivery of batch) {
      await this.attemptDelivery(delivery);
    }
  }

  private async attemptDelivery(delivery: WebhookDelivery): Promise<void> {
    let subscription;
    try {
      subscription = await this.subscriptions.findByIdForTenant(delivery.tenantId, delivery.webhookSubscriptionId);
    } catch {
      // Subscription no longer exists for this tenant - nothing further to
      // retry against; this delivery simply stops matching a future
      // `findPendingBatch` once it exhausts `MAX_DELIVERY_ATTEMPTS` on its
      // own, same as any other undeliverable row.
      await this.deliveries.recordFailure(delivery.tenantId, delivery.id, null);
      return;
    }

    if (subscription.status === WebhookSubscriptionStatus.DISABLED) {
      // Already given up on this subscription (own copy of Module 01's
      // `!subscription.isActive` skip) - a delivery that was queued before
      // the escalation crossed `DISABLED_THRESHOLD` shouldn't still spend
      // a real HTTP call on a receiver this module has already stopped
      // trusting. Still counts toward its own `retry_count` (not the
      // subscription's `consecutiveFailureCount`, already past
      // `DISABLED_THRESHOLD`) so it eventually stops matching
      // `findPendingBatch` on its own, rather than being reprocessed by
      // every future tick forever.
      await this.deliveries.recordFailure(delivery.tenantId, delivery.id, null);
      return;
    }

    let secret: string;
    try {
      const credential = await this.vault.read(subscription.secretReference);
      secret = credential.secret as string;
    } catch (err) {
      this.logger.error(
        `Failed to read Vault secret for webhook subscription ${subscription.id}: ${(err as Error).message}`,
      );
      await this.deliveries.recordFailure(delivery.tenantId, delivery.id, null);
      return;
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Date.now();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    try {
      const response = await fetch(subscription.targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agno-webhook-id': delivery.id,
          'x-agno-webhook-event-type': delivery.eventType,
          [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        await this.deliveries.markDelivered(delivery.tenantId, delivery.id, response.status);
        await this.subscriptions.recordDeliveryOutcome(delivery.tenantId, subscription.id, true);
        this.metrics.recordWebhookDelivery('delivered');
        return;
      }
      await this.handleFailure(delivery, subscription.id, response.status);
    } catch (err) {
      this.logger.warn(
        `Webhook delivery=${delivery.id} (tenant=${delivery.tenantId} subscription=${subscription.id}) request failed: ${(err as Error).message}`,
      );
      await this.handleFailure(delivery, subscription.id, null);
    }
  }

  private async handleFailure(
    delivery: WebhookDelivery,
    subscriptionId: string,
    statusCode: number | null,
  ): Promise<void> {
    await this.deliveries.recordFailure(delivery.tenantId, delivery.id, statusCode);
    await this.subscriptions.recordDeliveryOutcome(delivery.tenantId, subscriptionId, false);
    this.metrics.recordWebhookDelivery('failed');
  }
}
