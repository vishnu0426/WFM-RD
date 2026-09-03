import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { withTenantConnection } from '../database/with-tenant-connection';
import { WebhookDelivery } from '../integrations/entities/webhook-delivery.entity';

/**
 * §2.1's `WebhookDelivery` has no terminal-status column (unlike Module
 * 01's own `core.webhook_deliveries.status` enum) - `deliveredAt IS NOT
 * NULL` is success, and a row that has exhausted `MAX_DELIVERY_ATTEMPTS`
 * simply stops matching `findPendingBatch`'s own `retry_count < $1` filter
 * - an implicit dead-letter via the query itself, not a separate status
 * write. See the Phase 7 design doc.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

@Injectable()
export class WebhookDeliveriesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(MIGRATOR_PG_POOL) private readonly migratorPool: Pool,
  ) {}

  async enqueue(
    tenantId: string,
    subscriptionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(WebhookDelivery, {
        id: randomUUID(),
        tenantId,
        webhookSubscriptionId: subscriptionId,
        eventType,
        payload,
        responseStatusCode: null,
        deliveredAt: null,
        retryCount: 0,
        createdAt: new Date(),
      }),
    );
  }

  /**
   * Cross-tenant by design (own copy of `BatchSyncRunnerService.
   * findDueConnectors`'s doc comment: the dispatcher's tick is inherently
   * a scan across every tenant's pending deliveries, not one). Read-only
   * via the migrator pool; the dispatcher's own writes go through
   * `markDelivered`/`recordFailure` below, each using the row's own
   * `tenantId` via the normal RLS-scoped path.
   */
  async findPendingBatch(limit: number): Promise<WebhookDelivery[]> {
    const { rows } = await this.migratorPool.query<WebhookDelivery>(
      `SELECT id, tenant_id AS "tenantId", webhook_subscription_id AS "webhookSubscriptionId",
              event_type AS "eventType", payload, response_status_code AS "responseStatusCode",
              delivered_at AS "deliveredAt", retry_count AS "retryCount", created_at AS "createdAt"
       FROM integration_hub.webhook_delivery
       WHERE delivered_at IS NULL AND retry_count < $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [MAX_DELIVERY_ATTEMPTS, limit],
    );
    return rows;
  }

  async markDelivered(tenantId: string, deliveryId: string, responseStatusCode: number): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.update(WebhookDelivery, { id: deliveryId, tenantId }, { deliveredAt: new Date(), responseStatusCode }),
    );
  }

  async recordFailure(tenantId: string, deliveryId: string, responseStatusCode: number | null): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.query(
        `UPDATE integration_hub.webhook_delivery SET retry_count = retry_count + 1, response_status_code = $1 WHERE id = $2 AND tenant_id = $3`,
        [responseStatusCode, deliveryId, tenantId],
      ),
    );
  }

  async findAllForSubscription(tenantId: string, subscriptionId: string, limit: number): Promise<WebhookDelivery[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(WebhookDelivery).find({
        where: { tenantId, webhookSubscriptionId: subscriptionId },
        order: { createdAt: 'DESC' },
        take: limit,
      }),
    );
  }
}
