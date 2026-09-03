import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 5 (docs/adr/0123): `requires_human_approval` alone can't
 * tell `suggest_only` and `approve_required` apart at decision time (both
 * resolve it to `true`) - `AiRecommendationService.decideRecommendation`
 * needs to know which one it's looking at, since `suggest_only` never
 * executes anything even once a human marks it `approved` (purely
 * advisory - see that service's own doc comment). Backfilled as
 * `approve_required` for any pre-existing row (none exist yet in
 * practice - this table has no writer before this phase) - the safer of
 * the two `requires_human_approval: true` levels to assume retroactively,
 * never `auto_execute_low_risk`.
 */
export class AiRecommendationResolvedAutonomyLevel1700009300000 implements MigrationInterface {
  name = 'AiRecommendationResolvedAutonomyLevel1700009300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_layer.ai_recommendation ADD COLUMN resolved_autonomy_level varchar(30);`);
    await queryRunner.query(
      `UPDATE ai_layer.ai_recommendation SET resolved_autonomy_level = 'approve_required' WHERE resolved_autonomy_level IS NULL;`,
    );
    await queryRunner.query(
      `ALTER TABLE ai_layer.ai_recommendation ALTER COLUMN resolved_autonomy_level SET NOT NULL;`,
    );
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_recommendation ADD CONSTRAINT ai_recommendation_resolved_autonomy_level_check
      CHECK (resolved_autonomy_level IN ('suggest_only', 'approve_required', 'auto_execute_low_risk'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_layer.ai_recommendation DROP COLUMN resolved_autonomy_level;`);
  }
}
