import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-0159: `BidService.closeBidOpportunity` now converts a bid opportunity's
 * winner into a real `MarketplaceClaim`, the same as `ClaimOpenShiftService`
 * already does for a first-come claim - closing the gap the module's own
 * `MarketplaceEngagementService` doc comment flagged ("a bid's winner is
 * never turned into a real assignment/NATS handoff yet"). Distinguishing
 * *which* mechanism produced a given claim can't be inferred from context at
 * approval time (`ApproveMarketplaceActionService.approveClaim` may run long
 * after the claim was created by either path), so it has to be a real,
 * persisted column - not a value derived at the moment of approval.
 *
 * Existing rows default to `open_shift_claim`: every `MarketplaceClaim` ever
 * created before this migration came from `ClaimOpenShiftService`, since
 * `BidService` never created one until now.
 */
export class MarketplaceClaimSource1700003000000 implements MigrationInterface {
  name = 'MarketplaceClaimSource1700003000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_claim
      ADD COLUMN source varchar(20) NOT NULL DEFAULT 'open_shift_claim';
    `);
    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_claim
      ADD CONSTRAINT marketplace_claim_source_check
      CHECK (source IN ('open_shift_claim', 'bid'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_claim
      DROP CONSTRAINT IF EXISTS marketplace_claim_source_check;
    `);
    await queryRunner.query(`
      ALTER TABLE marketplace.marketplace_claim
      DROP COLUMN IF EXISTS source;
    `);
  }
}
