import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-14, P1: none of
 * `org.outbox_events` (Module 02), `core.outbox_events` (Module 01), or
 * `core.webhook_deliveries` (Module 01) had any mechanism to stop two
 * concurrent poller instances (`OutboxPublisherService` /
 * `CoreOutboxPublisherService` / `WebhookDeliveryDispatcherService`) from
 * both reading the same unpublished/pending batch and double-publishing -
 * `findUnpublishedBatch`/`findPendingBatch` were a plain `SELECT ... LIMIT`
 * with no row lock at all. Today this is latent (each of these three
 * services runs as a single instance), but it is exactly the kind of gap
 * that turns into a live incident the moment any of them is horizontally
 * scaled.
 *
 * Fix: a `claimed_at` lease column on all three tables. The repository
 * layer (not this migration) now claims a batch with a single
 * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
 * statement - two concurrent claimers skip each other's in-flight rows
 * instead of blocking-then-double-claiming. A claim expires after
 * `OUTBOX_CLAIM_LEASE_SECONDS` (default 60s, comfortably above this
 * codebase's slowest single-event publish path) so a poller that crashes
 * mid-batch doesn't strand its claimed rows forever - the accepted
 * trade-off (same shape as, e.g., SQS visibility timeouts) is that a
 * publish which itself takes longer than the lease can still be
 * double-attempted; that residual risk is independently closed by pairing
 * this with a JetStream `Nats-Msg-Id` (the outbox row's own `id`) on every
 * publish, so a genuine double-attempt still only lands once on the
 * consumer side.
 */
export class OutboxAndWebhookDeliveryClaimColumn1700000015000 implements MigrationInterface {
  name = 'OutboxAndWebhookDeliveryClaimColumn1700000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE org.outbox_events ADD COLUMN claimed_at timestamptz NULL;`);
    await queryRunner.query(`ALTER TABLE core.outbox_events ADD COLUMN claimed_at timestamptz NULL;`);
    await queryRunner.query(`ALTER TABLE core.webhook_deliveries ADD COLUMN claimed_at timestamptz NULL;`);

    // Partial indexes on the exact predicate the claim query filters by -
    // without one, the claim UPDATE's subquery falls back to a full-table
    // scan of every row as the unpublished/pending backlog grows.
    await queryRunner.query(`
      CREATE INDEX idx_org_outbox_events_claimable ON org.outbox_events (created_at)
      WHERE published_at IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_core_outbox_events_claimable ON core.outbox_events (created_at)
      WHERE published_at IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_core_webhook_deliveries_claimable ON core.webhook_deliveries (created_at)
      WHERE status = 'pending';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.idx_core_webhook_deliveries_claimable;`);
    await queryRunner.query(`DROP INDEX core.idx_core_outbox_events_claimable;`);
    await queryRunner.query(`DROP INDEX org.idx_org_outbox_events_claimable;`);
    await queryRunner.query(`ALTER TABLE core.webhook_deliveries DROP COLUMN claimed_at;`);
    await queryRunner.query(`ALTER TABLE core.outbox_events DROP COLUMN claimed_at;`);
    await queryRunner.query(`ALTER TABLE org.outbox_events DROP COLUMN claimed_at;`);
  }
}
