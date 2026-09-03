import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxEventsRepository } from './repositories/outbox-events.repository';
import { NatsClientService } from './services/nats-client.service';
import { OutboxPublisherService } from './services/outbox-publisher.service';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent])],
  providers: [OutboxEventsRepository, NatsClientService, OutboxPublisherService],
  exports: [TypeOrmModule, OutboxEventsRepository],
})
export class EventingModule {}
