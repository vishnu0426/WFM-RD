import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OutboxEvent } from '../entities/outbox-event.entity';

/** Same escape-hatch shape as `core.tenants` (ADR-0007) - the publisher polls across every tenant, not one. */
const SYSTEM_BATCH_CONTEXT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** GAP-14: how long a claim survives before another poller instance may reclaim the row - see `1700000015000-OutboxAndWebhookDeliveryClaimColumn`. */
const OUTBOX_CLAIM_LEASE_SECONDS = 60;

interface OutboxEventRow {
  id: string;
  tenant_id: string;
  subject: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
  claimed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

function toOutboxEvent(row: OutboxEventRow): OutboxEvent {
  const event = new OutboxEvent();
  event.id = row.id;
  event.tenantId = row.tenant_id;
  event.subject = row.subject;
  event.payload = row.payload;
  event.createdAt = row.created_at;
  event.publishedAt = row.published_at;
  event.claimedAt = row.claimed_at;
  event.attempts = row.attempts;
  event.lastError = row.last_error;
  return event;
}

/** The `core`-schema counterpart to Module 02's `OutboxEventsRepository` (ADR-0019/ADR-0039) - same shape, deliberately not shared code (each module owns its own schema). */
@Injectable()
export class CoreOutboxEventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Called from *inside* another repository's already-open transaction
   * (`AuditLogRepository.record`, `PoliciesRepository.createLineage`/
   * `.supersede`) - a plain static function taking that transaction's own
   * `EntityManager` rather than opening a new one, so this insert commits
   * atomically with the write that triggered it.
   */
  static async insertWithinTransaction(
    manager: EntityManager,
    tenantId: string,
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.getRepository(OutboxEvent).insert({
      id: uuidv4(),
      tenantId,
      subject,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
      lastError: null,
    });
  }

  /**
   * Cross-tenant by design - the publisher has no single tenant to scope to.
   *
   * GAP-14 fix: same atomic claim-via-UPDATE pattern as Module 02's
   * `OutboxEventsRepository.findUnpublishedBatch` - see that method's
   * comment for the full rationale.
   */
  async findUnpublishedBatch(limit: number): Promise<OutboxEvent[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      async (manager) => {
        // Correctness fix (found via real-Postgres integration testing on
        // Module 02's identical repository): TypeORM's `EntityManager.query()`
        // returns `[rows, rowCount]` for an UPDATE, even with RETURNING -
        // not the rows array directly. See that file's own comment for the
        // full explanation.
        const [rows]: [OutboxEventRow[], number] = await manager.query(
          `
            UPDATE core.outbox_events
            SET claimed_at = now()
            WHERE id IN (
              SELECT id FROM core.outbox_events
              WHERE published_at IS NULL
                AND (claimed_at IS NULL OR claimed_at < now() - ($2 || ' seconds')::interval)
              ORDER BY created_at ASC
              LIMIT $1
              FOR UPDATE SKIP LOCKED
            )
            RETURNING *
          `,
          [limit, OUTBOX_CLAIM_LEASE_SECONDS],
        );
        return rows.map(toOutboxEvent);
      },
    );
  }

  /** Phase 7 (ADR-0050): backs the `core_outbox_events_unpublished` gauge `MetricsController` exposes. */
  async countUnpublished(): Promise<number> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(OutboxEvent).count({ where: { publishedAt: IsNull() } as never }),
    );
  }

  async markPublished(id: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(OutboxEvent).update({ id }, { publishedAt: new Date() }),
    );
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager.query('UPDATE core.outbox_events SET attempts = attempts + 1, last_error = $1 WHERE id = $2', [
          error,
          id,
        ]),
    );
  }
}
