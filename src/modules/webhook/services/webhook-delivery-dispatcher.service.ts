import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac } from 'node:crypto';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';
import { WebhookSubscriptionsRepository } from '../repositories/webhook-subscriptions.repository';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5;
const DELIVERY_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER = 'x-agno-webhook-signature';

/**
 * ADR-0046: drains `core.webhook_deliveries` on a 5-second tick (faster
 * than `CoreOutboxPublisherService`'s 10s - webhook consumers are external
 * systems a tenant's own integration is waiting on, not an internal audit
 * pipeline) and POSTs each pending row to its subscription's `url`.
 *
 * Signing follows the same `t=<unix_ms>,v1=<hmac>` shape Stripe's webhook
 * signatures use: the HMAC is computed over `${timestamp}.${rawBody}`, not
 * the body alone, so a captured-and-replayed request can be rejected by a
 * receiver that also checks the timestamp is recent - a bare
 * body-only HMAC can't express that (the signature would still verify on a
 * byte-for-byte replay days later).
 */
@Injectable()
export class WebhookDeliveryDispatcherService {
  private readonly logger = new Logger(WebhookDeliveryDispatcherService.name);
  private ticking = false;

  constructor(
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly subscriptions: WebhookSubscriptionsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Cron('*/5 * * * * *')
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
    const subscription = await this.tenantContext.run({ tenantId: delivery.tenantId }, () =>
      this.subscriptions.findOne({ where: { id: delivery.subscriptionId } as never }),
    );
    if (!subscription || !subscription.isActive) {
      await this.deliveries.markDeadLettered(delivery.id, 'subscription deleted or deactivated since enqueue');
      return;
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Date.now();
    const signature = createHmac('sha256', subscription.secret).update(`${timestamp}.${body}`).digest('hex');

    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agno-webhook-id': delivery.id,
          'x-agno-webhook-subject': delivery.subject,
          [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        await this.deliveries.markDelivered(delivery.id);
        return;
      }
      await this.handleFailure(delivery, `HTTP ${response.status}`);
    } catch (err) {
      await this.handleFailure(delivery, (err as Error).message);
    }
  }

  private async handleFailure(delivery: WebhookDelivery, error: string): Promise<void> {
    if (delivery.attempts + 1 >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
      await this.deliveries.markDeadLettered(delivery.id, error);
      this.logger.error(
        `Webhook delivery=${delivery.id} (tenant=${delivery.tenantId} subject=${delivery.subject}) exhausted retries - dead-lettered: ${error}`,
      );
      return;
    }
    await this.deliveries.recordFailure(delivery.id, error);
    this.logger.warn(
      `Webhook delivery=${delivery.id} failed (attempt ${delivery.attempts + 1}/${MAX_ATTEMPTS_BEFORE_DEAD_LETTER}, tenant=${delivery.tenantId} subject=${delivery.subject}): ${error} - will retry`,
    );
  }
}
