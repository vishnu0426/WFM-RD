import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { WebhookSubscription, WebhookSubscriptionStatus } from '../integrations/entities/webhook-subscription.entity';
import { WebhookDeliveriesService } from './webhook-deliveries.service';

/**
 * ADR-0046's exact fan-out shape, reused a fourth time in this platform
 * (own copy of `WebhookFanoutService`'s doc comment: `core.pending_audit_
 * events`, `core.outbox_events`, and now this table are all the same
 * durable-queue idiom). Called from `SyncJobsService.complete()`
 * immediately after that write - not a separate poll loop - matching
 * "fan out right after the shared completion point," `SyncJobsService.
 * complete()` playing the role `CoreOutboxPublisherService.drain` plays
 * in Module 01: the one place every `SyncJob` (batch or streaming)
 * actually becomes durable.
 *
 * Deliberately not transactional with that write - fan-out failures are
 * caught and logged here, never propagated back to fail a real `SyncJob`
 * completion.
 */
@Injectable()
export class WebhookFanoutService {
  private readonly logger = new Logger(WebhookFanoutService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deliveries: WebhookDeliveriesService,
  ) {}

  async fanOut(tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const matching = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager
          .getRepository(WebhookSubscription)
          .createQueryBuilder('s')
          .where('s.tenant_id = :tenantId', { tenantId })
          .andWhere('s.status != :disabled', { disabled: WebhookSubscriptionStatus.DISABLED })
          .andWhere(':eventType = ANY(s.event_types)', { eventType })
          .getMany(),
      );
      for (const subscription of matching) {
        await this.deliveries.enqueue(tenantId, subscription.id, eventType, payload);
      }
    } catch (err) {
      this.logger.error(
        `Webhook fan-out failed for tenant=${tenantId} eventType=${eventType}: ${(err as Error).message}`,
      );
    }
  }
}
