import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { WebhookDelivery } from '../entities/webhook-delivery.entity';
import { WebhookDeliveryStatus } from '../entities/webhook-delivery-status.enum';

/** Same escape-hatch shape as `CoreOutboxEventsRepository`/`PendingAuditEventsRepository` - fan-out and the dispatcher both operate across every tenant, not one. */
const SYSTEM_BATCH_CONTEXT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** GAP-14: how long a claim survives before another dispatcher instance may reclaim the row - see `1700000015000-OutboxAndWebhookDeliveryClaimColumn`. */
const OUTBOX_CLAIM_LEASE_SECONDS = 60;

interface WebhookDeliveryRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  subject: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
  claimed_at: Date | null;
}

function toWebhookDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  const delivery = new WebhookDelivery();
  delivery.id = row.id;
  delivery.tenantId = row.tenant_id;
  delivery.subscriptionId = row.subscription_id;
  delivery.subject = row.subject;
  delivery.payload = row.payload;
  delivery.status = row.status;
  delivery.attempts = row.attempts;
  delivery.lastError = row.last_error;
  delivery.createdAt = row.created_at;
  delivery.deliveredAt = row.delivered_at;
  delivery.claimedAt = row.claimed_at;
  return delivery;
}

/** ADR-0046: the durable-queue repository behind `WebhookDeliveryDispatcherService`. */
@Injectable()
export class WebhookDeliveriesRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Called from `WebhookFanoutService`, itself called from `CoreOutboxPublisherService.drain` - not request-scoped, hence the platform-admin escape hatch. */
  async enqueue(
    tenantId: string,
    subscriptionId: string,
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin: true }, (manager) =>
      manager.getRepository(WebhookDelivery).insert({
        id: uuidv4(),
        tenantId,
        subscriptionId,
        subject,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
        status: WebhookDeliveryStatus.PENDING,
        attempts: 0,
        lastError: null,
        createdAt: new Date(),
        deliveredAt: null,
      }),
    );
  }

  /**
   * Cross-tenant by design - the dispatcher polls across every tenant's
   * pending deliveries in one tick.
   *
   * GAP-14 fix: same atomic claim-via-UPDATE pattern as
   * `OutboxEventsRepository.findUnpublishedBatch` (Module 02) - see that
   * method's comment for the full rationale.
   */
  async findPendingBatch(limit: number): Promise<WebhookDelivery[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      async (manager) => {
        // Correctness fix (found via real-Postgres integration testing on
        // Module 02's identical repository): TypeORM's `EntityManager.query()`
        // returns `[rows, rowCount]` for an UPDATE, even with RETURNING -
        // not the rows array directly. See `OutboxEventsRepository.findUnpublishedBatch`'s
        // own comment for the full explanation.
        const [rows]: [WebhookDeliveryRow[], number] = await manager.query(
          `
            UPDATE core.webhook_deliveries
            SET claimed_at = now()
            WHERE id IN (
              SELECT id FROM core.webhook_deliveries
              WHERE status = $3
                AND (claimed_at IS NULL OR claimed_at < now() - ($2 || ' seconds')::interval)
              ORDER BY created_at ASC
              LIMIT $1
              FOR UPDATE SKIP LOCKED
            )
            RETURNING *
          `,
          [limit, OUTBOX_CLAIM_LEASE_SECONDS, WebhookDeliveryStatus.PENDING],
        );
        return rows.map(toWebhookDelivery);
      },
    );
  }

  /** Phase 7 (ADR-0050): backs the `core_webhook_deliveries_pending` gauge `MetricsController` exposes. */
  async countPending(): Promise<number> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(WebhookDelivery).count({ where: { status: WebhookDeliveryStatus.PENDING } }),
    );
  }

  async markDelivered(id: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager
          .getRepository(WebhookDelivery)
          .update({ id }, { status: WebhookDeliveryStatus.DELIVERED, deliveredAt: new Date() }),
    );
  }

  async markDeadLettered(id: string, error: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager
          .getRepository(WebhookDelivery)
          .update({ id }, { status: WebhookDeliveryStatus.DEAD_LETTERED, lastError: error }),
    );
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager.query('UPDATE core.webhook_deliveries SET attempts = attempts + 1, last_error = $1 WHERE id = $2', [
          error,
          id,
        ]),
    );
  }
}
