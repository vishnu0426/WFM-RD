import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { WebhookSubscriptionsRepository } from '../repositories/webhook-subscriptions.repository';
import { WebhookDeliveriesRepository } from '../repositories/webhook-deliveries.repository';

/**
 * ADR-0046: called from `CoreOutboxPublisherService.drain` immediately after
 * a successful NATS publish - "this event is now live on the bus, who else
 * subscribed to hear about it via HTTP instead." Deliberately not
 * transactional with the NATS publish itself (an external side effect can't
 * participate in a Postgres transaction) - a fan-out that fails to enqueue
 * (Postgres unreachable at that exact moment) means a subscribed webhook
 * simply doesn't fire for that event, logged at ERROR as the last-resort
 * visibility floor (same posture as every other best-effort fan-out in this
 * module - see the Phase 6 readiness checklist).
 */
@Injectable()
export class WebhookFanoutService {
  private readonly logger = new Logger(WebhookFanoutService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly subscriptions: WebhookSubscriptionsRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
  ) {}

  async fanOut(tenantId: string, subject: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const matching = await this.tenantContext.run({ tenantId }, async () => {
        const active = await this.subscriptions.findActiveForTenant();
        return active.filter((s) => s.subscribedSubjects.includes(subject));
      });
      for (const subscription of matching) {
        await this.deliveries.enqueue(tenantId, subscription.id, subject, payload);
      }
    } catch (err) {
      this.logger.error(`Webhook fan-out failed for tenant=${tenantId} subject=${subject}: ${(err as Error).message}`);
    }
  }
}
