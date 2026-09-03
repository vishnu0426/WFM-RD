import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MarketplaceOutboxEventsRepository } from './repositories/marketplace-outbox-events.repository';
import { MarketplaceNatsClientService } from '../nats/nats-client.service';

const BATCH_SIZE = 100;
/**
 * Unlike the root platform-core service's outbox (`OutboxPublisherService`),
 * this module has no provisioned DLQ subject/stream to route exhausted
 * retries to (no `scripts/provision-nats-streams.ts` equivalent exists in
 * this service). Rather than invent a DLQ subject nothing yet
 * subscribes to, an event that has failed this many times just logs at
 * `error` level on every subsequent attempt (loud, not silent) and keeps
 * retrying - a lower publish rate under sustained NATS failure is an
 * acceptable trade-off for "never silently drop," which is the actual
 * GAP-02 requirement.
 */
const LOUD_RETRY_THRESHOLD = 5;

/**
 * GAP-02 fix (enterprise readiness audit, 2026-08-18): drains
 * `marketplace.marketplace_outbox_event` independently of whatever wrote
 * the rows (`ClaimOpenShiftService`/`BidService`/`SwapRequestService`/
 * `ApproveMarketplaceActionService`, via `MarketplaceEventPublisherService`)
 * - the write and the publish are deliberately decoupled so a NATS outage
 * never blocks (or is blocked by) the transactional write that recorded
 * the approval. Same drain-loop shape as the root service's
 * `OutboxPublisherService`/`CoreOutboxPublisherService` (ADR-0019/ADR-0039).
 */
@Injectable()
export class MarketplaceOutboxPublisherService {
  private readonly logger = new Logger(MarketplaceOutboxPublisherService.name);
  private ticking = false;

  constructor(
    private readonly outboxEventsRepository: MarketplaceOutboxEventsRepository,
    private readonly natsClient: MarketplaceNatsClientService,
  ) {}

  /** Re-entrancy guard, same reasoning as the root service's identically-shaped poller: a slow tick must not have a second tick start layering more work on top of it. */
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
    const batch = await this.outboxEventsRepository.findUnpublishedBatch(BATCH_SIZE);
    for (const event of batch) {
      try {
        // `event.id` as the JetStream `Nats-Msg-Id` - de-dupes a publish
        // that's retried after an ack was lost or after a reclaimed lease
        // causes the same row to be attempted twice (same GAP-14 fix the
        // root service's outbox now also has).
        await this.natsClient.publish(event.subject, event.payload, event.id);
        await this.outboxEventsRepository.markPublished(event.id);
      } catch (err) {
        const message = (err as Error).message;
        await this.outboxEventsRepository.recordFailure(event.id, message);
        const attemptNumber = event.attempts + 1;
        if (attemptNumber >= LOUD_RETRY_THRESHOLD) {
          this.logger.error(
            `Marketplace outbox publish failed (attempt ${attemptNumber}) for event=${event.id} subject=${event.subject} tenant=${event.tenantId}: ${message} - still retrying, no DLQ configured for this module`,
          );
        } else {
          this.logger.warn(
            `Marketplace outbox publish failed (attempt ${attemptNumber}) for event=${event.id} subject=${event.subject}: ${message}`,
          );
        }
      }
    }
  }
}
