import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { WebhookSubscriptionsRepository } from './repositories/webhook-subscriptions.repository';
import { WebhookDeliveriesRepository } from './repositories/webhook-deliveries.repository';
import { WebhookFanoutService } from './services/webhook-fanout.service';
import { WebhookDeliveryDispatcherService } from './services/webhook-delivery-dispatcher.service';

/**
 * Phase 6 (§3.2, ADR-0046): webhook subscription CRUD + durable delivery
 * queue. `WebhookFanoutService` is exported so `CoreEventingModule` can call
 * it from `CoreOutboxPublisherService.drain` - see that service's updated
 * doc comment. No cycle risk: this module depends on nothing outside itself
 * (`TypeOrmModule.forFeature` only).
 *
 * `WebhookDeliveriesRepository` is exported alongside `WebhookSubscriptionsRepository`
 * (Phase 7, ADR-0050) - `MetricsModule` injects it directly for the
 * webhook-delivery-queue-depth gauge, the same shape as the other two leaf
 * modules' repositories it depends on. Missing until this fix - the
 * omission only surfaced when something actually tried to boot
 * `MetricsModule` (`Nest can't resolve dependencies of the MetricsService`),
 * which nothing in this repo's own test suite exercises via a full
 * `AppModule` boot.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebhookSubscription, WebhookDelivery])],
  providers: [
    WebhookSubscriptionsRepository,
    WebhookDeliveriesRepository,
    WebhookFanoutService,
    WebhookDeliveryDispatcherService,
  ],
  exports: [TypeOrmModule, WebhookSubscriptionsRepository, WebhookDeliveriesRepository, WebhookFanoutService],
})
export class WebhookModule {}
