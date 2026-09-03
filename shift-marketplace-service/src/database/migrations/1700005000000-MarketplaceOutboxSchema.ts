import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-02, P0: `MarketplaceEventPublisherService`
 * previously published `ShiftClaimApproved`/`SwapExecuted` directly to NATS,
 * after the Postgres transaction that approved the claim/swap had already
 * committed, inside a bare `try { publish } catch { log }` - the exact
 * "commit, then publish" anti-pattern this audit calls out by name. A NATS
 * outage at that exact instant meant the event was lost permanently: no
 * retry, no DLQ, and (unlike attendance-leave-service's identically-shaped
 * best-effort publish) no compensating pull-path for scheduling-service to
 * independently discover the approval. The employee sees "claimed"; the
 * shift never actually gets locked in as an assignment.
 *
 * Fix: a genuine transactional outbox, the same shape the root platform-core
 * service's `org.outbox_events`/`core.outbox_events` already use (ADR-0019/
 * ADR-0039) - `marketplace_outbox_event` is written in the *same* database
 * transaction as the claim/swap status write it describes
 * (`ClaimOpenShiftService`/`BidService`/`SwapRequestService`/
 * `ApproveMarketplaceActionService`, all four now insert here instead of
 * calling NATS directly), and a separate poller
 * (`MarketplaceOutboxPublisherService`) drains it independently with
 * retry/DLQ semantics.
 *
 * Built with a `claimed_at` lease column and its own claimable partial
 * index from day one, rather than retrofitted later the way the root
 * service's outbox needed (GAP-14 in this same audit) - two concurrent
 * poller instances must never both claim and publish the same row.
 */
export class MarketplaceOutboxSchema1700005000000 implements MigrationInterface {
  name = 'MarketplaceOutboxSchema1700005000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE marketplace.marketplace_outbox_event (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        subject       varchar(255) NOT NULL,
        payload       jsonb NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        published_at  timestamptz,
        claimed_at    timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text,
        PRIMARY KEY (id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_marketplace_outbox_event_tenant_published
      ON marketplace.marketplace_outbox_event (tenant_id, published_at);
    `);

    // The poller's own claim query filter (`published_at IS NULL`) - without
    // this, the claim UPDATE's subquery falls back to a full-table scan as
    // the published backlog grows (same fix as GAP-14's
    // `idx_org_outbox_events_claimable`).
    await queryRunner.query(`
      CREATE INDEX idx_marketplace_outbox_event_claimable ON marketplace.marketplace_outbox_event (created_at)
      WHERE published_at IS NULL;
    `);

    await queryRunner.query(`ALTER TABLE marketplace.marketplace_outbox_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON marketplace.marketplace_outbox_event FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    // UPDATE (not just SELECT/INSERT): the poller's claim/markPublished/
    // recordFailure steps all mutate this table - unlike
    // `marketplace_engagement_event`'s append-only grant, this table is a
    // drain queue, not a ledger.
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON marketplace.marketplace_outbox_event TO agno_marketplace_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace.marketplace_outbox_event;`);
  }
}
