import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationDeliveryRepository } from '../repositories/notification-delivery.repository';
import { NOTIFICATION_CHANNEL_ADAPTERS, NotificationChannelAdapter } from '../channels/notification-channel-adapter';

const BATCH_SIZE = 100;
/**
 * Same reasoning as `MarketplaceOutboxPublisherService`'s `LOUD_RETRY_THRESHOLD`
 * (shift-marketplace-service, GAP-02 fix, this same audit): after this many
 * failed attempts, mark the row `failed` (stop silently retrying forever)
 * and log loudly - an operator/on-call signal, not a DLQ this module
 * doesn't have anywhere to route to.
 */
const MAX_ATTEMPTS_BEFORE_GIVING_UP = 5;

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): drains
 * `core.notification_delivery` independently of whatever enqueued the rows
 * (`NotificationService.enqueue`) - same drain-loop shape as this
 * repository's other pollers (`OutboxPublisherService`/`CoreOutboxPublisherService`/
 * `WebhookDeliveryDispatcherService`), dispatching each row to the
 * `NotificationChannelAdapter` registered for its `channel`. Deliberately
 * does not depend on `MetricsService` directly - see `NotificationService`'s
 * own doc comment on why (dependency-cycle avoidance); queue depth is
 * exposed via `NotificationDeliveryRepository.countPending()`, pulled by
 * `MetricsService`'s own gauge, same as every other queue in this codebase.
 */
@Injectable()
export class NotificationDeliveryDispatcherService {
  private readonly logger = new Logger(NotificationDeliveryDispatcherService.name);
  private ticking = false;
  private readonly adaptersByChannel: Map<string, NotificationChannelAdapter>;

  constructor(
    private readonly deliveryRepository: NotificationDeliveryRepository,
    @Inject(NOTIFICATION_CHANNEL_ADAPTERS) adapters: NotificationChannelAdapter[],
  ) {
    this.adaptersByChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  }

  /** Re-entrancy guard, same reasoning as every other poller in this codebase: a slow tick must not have a second tick start layering more work on top of it. */
  @Cron('*/10 * * * * *')
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
    const batch = await this.deliveryRepository.findPendingBatch(BATCH_SIZE);
    for (const delivery of batch) {
      const adapter = this.adaptersByChannel.get(delivery.channel);
      if (!adapter) {
        // No adapter registered for this channel at all - a config error,
        // not a transient failure. Skip rather than retry forever.
        this.logger.error(
          `No NotificationChannelAdapter registered for channel=${delivery.channel} (delivery=${delivery.id}) - skipping.`,
        );
        await this.deliveryRepository.markSkipped(delivery.id);
        continue;
      }

      try {
        await adapter.send({
          tenantId: delivery.tenantId,
          userId: delivery.userId,
          channel: delivery.channel,
          eventType: delivery.eventType,
          payload: delivery.payload,
        });
        await this.deliveryRepository.markSent(delivery.id);
      } catch (err) {
        const message = (err as Error).message;
        const attemptNumber = delivery.attempts + 1;
        const exhausted = attemptNumber >= MAX_ATTEMPTS_BEFORE_GIVING_UP;
        await this.deliveryRepository.recordFailure(delivery.id, message, exhausted);
        const log = exhausted ? this.logger.error.bind(this.logger) : this.logger.warn.bind(this.logger);
        log(
          `Notification delivery failed (attempt ${attemptNumber}${exhausted ? ', giving up' : ''}) for delivery=${delivery.id} channel=${delivery.channel} tenant=${delivery.tenantId}: ${message}`,
        );
      }
    }
  }
}
