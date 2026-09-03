import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shift Marketplace Manager View phase, §2: the approval queue's
 * `rejectMarketplaceAction(reason: String!)` - neither `marketplace_claim`
 * nor `swap_request` had anywhere to persist a rejection reason before
 * this phase.
 */
export class MarketplaceDecisionReason1700006000000 implements MigrationInterface {
  name = 'MarketplaceDecisionReason1700006000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE marketplace.marketplace_claim ADD COLUMN decision_reason text;`);
    await queryRunner.query(`ALTER TABLE marketplace.swap_request ADD COLUMN decision_reason text;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE marketplace.swap_request DROP COLUMN IF EXISTS decision_reason;`);
    await queryRunner.query(`ALTER TABLE marketplace.marketplace_claim DROP COLUMN IF EXISTS decision_reason;`);
  }
}
