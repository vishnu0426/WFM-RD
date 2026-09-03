import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { NotificationDelivery, NotificationDeliveryStatus } from '../entities/notification-delivery.entity';

/**
 * Nil UUID placeholder for the dispatcher's platform-wide session - same
 * pattern/reasoning as `OutboxEventsRepository`'s
 * `SYSTEM_BATCH_CONTEXT_TENANT_ID` (`src/modules/eventing/repositories/outbox-events.repository.ts`):
 * `core.notification_delivery`'s own RLS policy grants full cross-tenant
 * visibility to `is_platform_admin` sessions regardless of `current_tenant_id`.
 */
const SYSTEM_BATCH_CONTEXT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** How long a claim survives before another dispatcher instance may reclaim the row - same value as the outbox repositories (GAP-14, this same audit). */
const CLAIM_LEASE_SECONDS = 60;

interface NotificationDeliveryRow {
  id: string;
  tenant_id: string;
  user_id: string;
  channel: NotificationChannel;
  event_type: string;
  payload: Record<string, unknown>;
  status: NotificationDeliveryStatus;
  created_at: Date;
  sent_at: Date | null;
  claimed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

function toNotificationDelivery(row: NotificationDeliveryRow): NotificationDelivery {
  const delivery = new NotificationDelivery();
  delivery.id = row.id;
  delivery.tenantId = row.tenant_id;
  delivery.userId = row.user_id;
  delivery.channel = row.channel;
  delivery.eventType = row.event_type;
  delivery.payload = row.payload;
  delivery.status = row.status;
  delivery.createdAt = row.created_at;
  delivery.sentAt = row.sent_at;
  delivery.claimedAt = row.claimed_at;
  delivery.attempts = row.attempts;
  delivery.lastError = row.last_error;
  return delivery;
}

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): the repository
 * behind `core.notification_delivery` (see `1700000016000-NotificationDeliverySchema`).
 * `enqueue` is tenant-scoped (RLS, via the caller's own tenant context);
 * everything else is cross-tenant by design and runs as the platform-admin
 * escape hatch, same shape as `OutboxEventsRepository`/`CoreOutboxEventsRepository`.
 */
@Injectable()
export class NotificationDeliveryRepository {
  constructor(private readonly dataSource: DataSource) {}

  async enqueue(
    tenantId: string,
    userId: string,
    channel: NotificationChannel,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      manager.getRepository(NotificationDelivery).insert({
        id: uuidv4(),
        tenantId,
        userId,
        channel,
        eventType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
        status: NotificationDeliveryStatus.PENDING,
        createdAt: new Date(),
        sentAt: null,
        claimedAt: null,
        attempts: 0,
        lastError: null,
      }),
    );
  }

  /** Phase 7-equivalent (ADR-0050 convention): backs `MetricsService`'s `core_notification_delivery_pending` gauge, same shape as `WebhookDeliveriesRepository.countPending`. */
  async countPending(): Promise<number> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager
          .getRepository(NotificationDelivery)
          .count({ where: { status: NotificationDeliveryStatus.PENDING } as never }),
    );
  }

  /**
   * Cross-tenant by design - the dispatcher has no single tenant to scope
   * to. Claims the batch atomically via a single `UPDATE ... WHERE id IN
   * (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`, built claim-safe from
   * the start (same reasoning as `OutboxEventsRepository.findUnpublishedBatch`,
   * which needed this retrofitted after the fact - GAP-14, this same audit).
   */
  async findPendingBatch(limit: number): Promise<NotificationDelivery[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      async (manager) => {
        // TypeORM's `EntityManager.query()` returns `[rows, rowCount]` for
        // an UPDATE (even with RETURNING), NOT the rows array directly -
        // only a plain SELECT gets that shortcut
        // (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js`'s
        // `query()`: `case 'UPDATE': result.raw = [raw.rows, raw.rowCount]`
        // vs `default: result.raw = raw.rows`). Destructuring the tuple
        // here is required - treating the return value as the rows array
        // directly silently maps two garbage "rows" (the real rows array
        // itself, then a number) instead of the real claimed rows. Caught
        // by `test/integration/notification-delivery.spec.ts` against real
        // Postgres, not by unit tests (which mock `manager.query` and so
        // never exercise the driver's actual return shape).
        const [rows]: [NotificationDeliveryRow[], number] = await manager.query(
          `
            UPDATE core.notification_delivery
            SET claimed_at = now()
            WHERE id IN (
              SELECT id FROM core.notification_delivery
              WHERE status = $3
                AND (claimed_at IS NULL OR claimed_at < now() - ($2 || ' seconds')::interval)
              ORDER BY created_at ASC
              LIMIT $1
              FOR UPDATE SKIP LOCKED
            )
            RETURNING *
          `,
          [limit, CLAIM_LEASE_SECONDS, NotificationDeliveryStatus.PENDING],
        );
        return rows.map(toNotificationDelivery);
      },
    );
  }

  async markSent(id: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager
          .getRepository(NotificationDelivery)
          .update({ id }, { status: NotificationDeliveryStatus.SENT, sentAt: new Date() }),
    );
  }

  async markSkipped(id: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager.getRepository(NotificationDelivery).update({ id }, { status: NotificationDeliveryStatus.SKIPPED }),
    );
  }

  async recordFailure(id: string, error: string, exhausted: boolean): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager.query(
          `UPDATE core.notification_delivery SET attempts = attempts + 1, last_error = $1, status = $2 WHERE id = $3`,
          [error, exhausted ? NotificationDeliveryStatus.FAILED : NotificationDeliveryStatus.PENDING, id],
        ),
    );
  }
}
