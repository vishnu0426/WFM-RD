import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-01, P0: "exactly one winner
 * per open shift" was enforced *only* by `MarketplaceRedisService`'s 5s
 * `SET NX EX` lock in `ClaimOpenShiftService.claim`/`BidService.
 * convertWinningBidToClaim` - `processClaim`/`convertWinningBidToClaim`
 * themselves did plain read-then-write against `marketplace_post`/
 * `marketplace_claim` with no unique constraint or row lock backing them
 * up. If the Redis lock expired, was skipped, or Redis partitioned, two
 * concurrent callers could both create a live claim for the same post and
 * both flip it to `claimed`.
 *
 * Fix: a partial unique index on `marketplace_claim.marketplace_post_id`,
 * scoped to the three "live" claim statuses (`pending_validation`,
 * `pending_approval`, `approved` - `rejected`/`superseded` are terminal and
 * explicitly excluded so a post remains claimable again once a claim
 * reaches one of those). This is the single enforcement point for *both*
 * contested-write paths into this table: `ClaimOpenShiftService.
 * processClaim`'s initial `pending_validation` insert, and `BidService.
 * convertWinningBidToClaim`'s `approved`/`pending_approval` insert - both
 * create a `MarketplaceClaim` row for the same `marketplace_post_id`, so a
 * second writer's `INSERT` now fails at the database layer with a unique
 * violation (`23505`) regardless of whether the Redis lock that was
 * supposed to prevent it actually held. The application-layer changes that
 * catch this violation and turn it into the existing
 * `PostAlreadyBeingClaimedError`/no-op-and-log outcomes are in
 * `ClaimOpenShiftService`/`BidService` themselves, not this migration.
 */
export class OneLiveClaimPerPost1700004000000 implements MigrationInterface {
  name = 'OneLiveClaimPerPost1700004000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_marketplace_claim_one_live_per_post
      ON marketplace.marketplace_claim (marketplace_post_id)
      WHERE status IN ('pending_validation', 'pending_approval', 'approved');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX marketplace.uq_marketplace_claim_one_live_per_post;`);
  }
}
