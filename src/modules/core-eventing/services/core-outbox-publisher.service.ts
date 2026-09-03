import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoreOutboxEventsRepository } from '../repositories/outbox-events.repository';
import { NatsClientService } from './nats-client.service';
import { SUBJECTS } from '../subjects';
import { WebhookFanoutService } from '../../webhook/services/webhook-fanout.service';

const BATCH_SIZE = 100;
/** §4's dead-letter stream: after this many failed attempts, stop retrying the original subject and route to the DLQ instead. */
const MAX_ATTEMPTS_BEFORE_DLQ = 5;

/**
 * ADR-0039's outbox drain loop - the `core`-schema counterpart to Module
 * 02's `OutboxPublisherService` (ADR-0019), same drain/retry/DLQ logic.
 * Ticks independently of whatever wrote the rows (`AuditLogRepository`,
 * `PoliciesRepository`) so a NATS outage never blocks the transactional
 * write that recorded the event.
 *
 * Phase 6 (ADR-0046): also fans out to any tenant webhook subscriptions
 * matching the event's subject, immediately after a successful NATS
 * publish - "this event is live on the bus, who else asked to hear about
 * it over HTTP." A fan-out failure never affects the outbox row's own
 * publish/DLQ bookkeeping (`WebhookFanoutService.fanOut` swallows and logs
 * its own errors) - a webhook subscriber's downtime must not stall the
 * NATS pipeline for every other consumer.
 */
@Injectable()
export class CoreOutboxPublisherService {
  private readonly logger = new Logger(CoreOutboxPublisherService.name);
  private ticking = false;

  constructor(
    private readonly outboxEventsRepository: CoreOutboxEventsRepository,
    private readonly natsClient: NatsClientService,
    private readonly webhookFanout: WebhookFanoutService,
  ) {}

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
        await this.natsClient.publish(event.subject, event.payload, event.id);
        await this.outboxEventsRepository.markPublished(event.id);
        await this.webhookFanout.fanOut(event.tenantId, event.subject, event.payload);
      } catch (err) {
        const message = (err as Error).message;
        if (event.attempts + 1 >= MAX_ATTEMPTS_BEFORE_DLQ) {
          await this.routeToDlq(event.id, event.subject, event.payload, message);
        } else {
          await this.outboxEventsRepository.recordFailure(event.id, message);
          this.logger.warn(
            `Outbox publish failed (attempt ${event.attempts + 1}) for event=${event.id} subject=${event.subject}: ${message}`,
          );
        }
      }
    }
  }

  private async routeToDlq(
    id: string,
    originalSubject: string,
    payload: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    try {
      await this.natsClient.publish(SUBJECTS.DLQ, { originalSubject, payload, error }, `${id}:dlq`);
      await this.outboxEventsRepository.markPublished(id);
      this.logger.error(
        `Outbox event=${id} subject=${originalSubject} exhausted retries - routed to ${SUBJECTS.DLQ}: ${error}`,
      );
    } catch (dlqErr) {
      await this.outboxEventsRepository.recordFailure(id, `DLQ publish also failed: ${(dlqErr as Error).message}`);
    }
  }
}
