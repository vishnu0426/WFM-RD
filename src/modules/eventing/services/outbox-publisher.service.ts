import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OutboxEventsRepository } from '../repositories/outbox-events.repository';
import { NatsClientService } from './nats-client.service';
import { SUBJECTS } from '../subjects';

const BATCH_SIZE = 100;
/** §4's dead-letter stream: after this many failed attempts, stop retrying the original subject and route to the DLQ instead. */
const MAX_ATTEMPTS_BEFORE_DLQ = 5;

/**
 * ADR-0019's outbox drain loop. Ticks independently of whatever wrote the
 * rows (`EmployeesRepository`/`SkillDecayJobService`) - the write and the
 * publish are deliberately decoupled so a NATS outage never blocks (or is
 * blocked by) the transactional write that recorded the event.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private ticking = false;

  constructor(
    private readonly outboxEventsRepository: OutboxEventsRepository,
    private readonly natsClient: NatsClientService,
  ) {}

  /**
   * Re-entrancy guard: a tick processing a large backlog (each unreachable
   * publish now fails fast off `NatsClientService`'s cooldown, but a big
   * batch can still take longer than the 10s tick interval) must not have a
   * second tick start layering more work on top of it - that compounds
   * into an ever-growing pile of concurrent ticks instead of just a slow
   * one.
   */
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
      // Even the DLQ publish failed (NATS likely just unreachable) - leave
      // the row unpublished so the next tick tries again. It will keep
      // re-attempting the DLQ route (attempts already >= threshold), not
      // the original subject, since this branch only runs once attempts
      // has crossed MAX_ATTEMPTS_BEFORE_DLQ.
      await this.outboxEventsRepository.recordFailure(id, `DLQ publish also failed: ${(dlqErr as Error).message}`);
    }
  }
}
