import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { OutboxEvent } from '../entities/outbox-event.entity';

/**
 * Nil UUID placeholder for the publisher's platform-wide session (same
 * pattern/reasoning as `SkillDecaySchedulerService`'s
 * `SYSTEM_BATCH_CONTEXT_TENANT_ID` - `core.tenants`' RLS grants full
 * cross-tenant visibility to `is_platform_admin` sessions regardless of
 * `current_tenant_id`, and `org.outbox_events`' own policy does the same,
 * ADR-0019).
 */
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

@Injectable()
export class OutboxEventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Called from *inside* another repository's already-open transaction
   * (e.g. `EmployeesRepository.createWithOutboxEvent`) - deliberately a
   * plain static function taking that transaction's own `EntityManager`
   * rather than opening a new one, since the whole point (ADR-0019) is that
   * this insert commits atomically with the entity write that triggered it.
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
      // TypeORM's QueryDeepPartialEntity recursion doesn't handle a plain
      // `Record<string, unknown>` jsonb column type cleanly - the payload
      // shape is genuinely arbitrary JSON (per event type), so there's no
      // narrower type to give it instead.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      createdAt: new Date(),
      publishedAt: null,
      attempts: 0,
      lastError: null,
    });
  }

  /**
   * Standalone record, for callers with no existing open transaction to
   * piggyback on (e.g. `SkillDecayJobService`'s `SkillExpiring` alerts,
   * which aren't tied to a single competing entity write the way
   * `EmployeeChanged` is tied to the `Employee` row it describes).
   */
  async record(tenantId: string, subject: string, payload: Record<string, unknown>): Promise<void> {
    await withTenantTransaction(this.dataSource, { tenantId }, (manager) =>
      OutboxEventsRepository.insertWithinTransaction(manager, tenantId, subject, payload),
    );
  }

  /**
   * Cross-tenant by design - the publisher has no single tenant to scope to.
   *
   * GAP-14 fix: claims the batch atomically via a single `UPDATE ... WHERE
   * id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *` rather than a
   * plain `SELECT`. Two concurrent poller instances calling this
   * simultaneously each skip whatever the other has already locked, so the
   * same row is never returned to both - the previous plain `SELECT` gave
   * no such guarantee and would double-publish under horizontal scaling.
   * A claim that's never followed by `markPublished`/`recordFailure`
   * (poller crash mid-batch) becomes reclaimable after
   * `OUTBOX_CLAIM_LEASE_SECONDS`.
   */
  async findUnpublishedBatch(limit: number): Promise<OutboxEvent[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      async (manager) => {
        // Correctness fix (found via real-Postgres integration testing
        // while building GAP-05's identical pattern): TypeORM's
        // `EntityManager.query()` returns `[rows, rowCount]` for an
        // UPDATE - even one with RETURNING - not the rows array directly;
        // only a plain SELECT gets that shortcut
        // (`PostgresQueryRunner.query()`: `case 'UPDATE': result.raw =
        // [raw.rows, raw.rowCount]` vs `default: result.raw = raw.rows`).
        // The un-destructured version silently mapped garbage "rows" (the
        // real array, then a row count) instead of the claimed batch -
        // unit tests never caught it because they mock `manager.query`
        // and never exercise the driver's actual return shape.
        const [rows]: [OutboxEventRow[], number] = await manager.query(
          `
            UPDATE org.outbox_events
            SET claimed_at = now()
            WHERE id IN (
              SELECT id FROM org.outbox_events
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
        manager.query('UPDATE org.outbox_events SET attempts = attempts + 1, last_error = $1 WHERE id = $2', [
          error,
          id,
        ]),
    );
  }
}
