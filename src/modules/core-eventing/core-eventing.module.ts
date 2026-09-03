import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { CoreOutboxEventsRepository } from './repositories/outbox-events.repository';
import { NatsClientService } from './services/nats-client.service';
import { CoreOutboxPublisherService } from './services/core-outbox-publisher.service';
import { WebhookModule } from '../webhook/webhook.module';

/**
 * Module 01 Phase 5 (§8, §4): the transactional outbox for `AuditEvent`/
 * `PolicyChanged` (ADR-0039). Exported so `AuditModule` and `PolicyModule`
 * can write outbox rows within their own entities' transactions.
 *
 * Phase 6 (ADR-0046): imports `WebhookModule` so `CoreOutboxPublisherService`
 * can fan out a successfully-published event to any matching tenant webhook
 * subscriptions - see that service's updated doc comment. No cycle risk:
 * `WebhookModule` depends on nothing outside itself.
 */
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), WebhookModule],
  providers: [CoreOutboxEventsRepository, NatsClientService, CoreOutboxPublisherService],
  exports: [TypeOrmModule, CoreOutboxEventsRepository, NatsClientService],
})
export class CoreEventingModule {}
