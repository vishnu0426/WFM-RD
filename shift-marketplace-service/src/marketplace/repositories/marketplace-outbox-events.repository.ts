import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { MIGRATOR_PG_POOL } from '../../database/migrator-pool.provider';
import { MarketplaceOutboxEvent } from '../entities/marketplace-outbox-event.entity';

/** How long a claim survives before another poller instance may reclaim the row - matches the root platform-core service's `OUTBOX_CLAIM_LEASE_SECONDS` (GAP-14). */
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

function toOutboxEvent(row: OutboxEventRow): MarketplaceOutboxEvent {
  const event = new MarketplaceOutboxEvent();
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

/**
 * GAP-02 fix (enterprise readiness audit, 2026-08-18): the repository
 * behind `marketplace.marketplace_outbox_event` (see
 * `1700005000000-MarketplaceOutboxSchema`). `insertWithinTransaction` is
 * tenant-scoped (RLS, via the caller's own `withTenantConnection` manager);
 * everything else is cross-tenant by design and goes through the migrator
 * pool (`MIGRATOR_PG_POOL`, the same pattern `BidCloseSweepService` already
 * established in this service) since `agno_marketplace_app` cannot see
 * rows outside whatever single tenant a transaction happens to be bound to.
 */
@Injectable()
export class MarketplaceOutboxEventsRepository {
  /**
   * Called from *inside* another service's already-open
   * `withTenantConnection` transaction (`ClaimOpenShiftService`/
   * `BidService`/`SwapRequestService`/`ApproveMarketplaceActionService`) -
   * a plain static function taking that transaction's own `EntityManager`
   * rather than opening a new one, so this insert commits atomically with
   * the claim/swap status write that triggered it.
   */
  static async insertWithinTransaction(
    manager: EntityManager,
    tenantId: string,
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.getRepository(MarketplaceOutboxEvent).insert({
      id: uuidv4(),
      tenantId,
      subject,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      createdAt: new Date(),
      publishedAt: null,
      claimedAt: null,
      attempts: 0,
      lastError: null,
    });
  }

  constructor(@Inject(MIGRATOR_PG_POOL) private readonly migratorPool: Pool) {}

  /**
   * Cross-tenant by design - the poller has no single tenant to scope to.
   * Claims the batch atomically via a single `UPDATE ... WHERE id IN
   * (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`, built claim-safe from
   * the start (unlike the root service's outbox, which needed this
   * retrofitted - GAP-14 in this same audit).
   */
  async findUnpublishedBatch(limit: number): Promise<MarketplaceOutboxEvent[]> {
    const result = await this.migratorPool.query<OutboxEventRow>(
      `
        UPDATE marketplace.marketplace_outbox_event
        SET claimed_at = now()
        WHERE id IN (
          SELECT id FROM marketplace.marketplace_outbox_event
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
    return result.rows.map(toOutboxEvent);
  }

  async markPublished(id: string): Promise<void> {
    await this.migratorPool.query(
      `UPDATE marketplace.marketplace_outbox_event SET published_at = now() WHERE id = $1`,
      [id],
    );
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await this.migratorPool.query(
      `UPDATE marketplace.marketplace_outbox_event SET attempts = attempts + 1, last_error = $1 WHERE id = $2`,
      [error, id],
    );
  }
}
