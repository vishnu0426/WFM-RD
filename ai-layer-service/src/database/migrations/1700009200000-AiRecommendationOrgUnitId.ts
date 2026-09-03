import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 5 (docs/adr/0125): §6.1 names `pendingRecommendations(orgUnitId)`
 * as a real query parameter - `ai_recommendation` had no `org_unit_id`
 * column to filter on. Additive migration (Phase 1's initial migration is
 * never edited after landing, same convention as `AiProviderConfigTable`).
 * Nullable - not every `source_module` can supply one at creation time
 * (see the entity's own doc comment).
 */
export class AiRecommendationOrgUnitId1700009200000 implements MigrationInterface {
  name = 'AiRecommendationOrgUnitId1700009200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ai_layer.ai_recommendation ADD COLUMN org_unit_id uuid;`);
    await queryRunner.query(`
      CREATE INDEX idx_ai_recommendation_tenant_org_unit_status
      ON ai_layer.ai_recommendation (tenant_id, org_unit_id, status)
      WHERE org_unit_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ai_layer.idx_ai_recommendation_tenant_org_unit_status;`);
    await queryRunner.query(`ALTER TABLE ai_layer.ai_recommendation DROP COLUMN org_unit_id;`);
  }
}
