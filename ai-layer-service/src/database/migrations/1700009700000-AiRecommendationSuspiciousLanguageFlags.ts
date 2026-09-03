import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 9 (docs/adr/0133, closing ADR-0131's own disclosed
 * rationaleText-passthrough finding): `AiRecommendationService.createFromInteraction`
 * now runs `detectSuspiciousRationalePhrases` over the generating
 * interaction's `outputText` and stores the result here - a heuristic,
 * disclosed-as-incomplete signal surfaced to the human reviewer (via
 * `AIRecommendation.suspiciousLanguageFlags` in GraphQL), and, if any
 * phrase is found, a fail-closed override: an otherwise-`auto_execute_low_risk`-
 * eligible recommendation is forced to `requires_human_approval: true`
 * regardless (§3's own "a recommendation failing any threshold check falls
 * back to approve_required" posture, extended to this new criterion).
 *
 * Additive migration (every prior migration in this module's history is
 * never edited after landing).
 */
export class AiRecommendationSuspiciousLanguageFlags1700009700000 implements MigrationInterface {
  name = 'AiRecommendationSuspiciousLanguageFlags1700009700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_recommendation
        ADD COLUMN suspicious_language_flags jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_recommendation
        DROP COLUMN suspicious_language_flags;
    `);
  }
}
