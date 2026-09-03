import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 5 (docs/adr/0125): `ai_governance_policy.updated_by` was
 * `NOT NULL` since Phase 1, written before any real caller of
 * `updateGovernancePolicy` existed. No user-identity resolution exists
 * anywhere in this module (the same disclosed gap `AIInteraction.user_id`'s
 * own nullability already carries) - `null` is the honest value, not a
 * fabricated id.
 */
export class AiGovernancePolicyUpdatedByNullable1700009400000 implements MigrationInterface {
  name = 'AiGovernancePolicyUpdatedByNullable1700009400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_layer.ai_governance_policy ALTER COLUMN updated_by DROP NOT NULL;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_layer.ai_governance_policy ALTER COLUMN updated_by SET NOT NULL;`);
  }
}
