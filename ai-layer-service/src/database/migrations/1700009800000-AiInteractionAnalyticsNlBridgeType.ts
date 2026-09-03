import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-0165: adds `'analytics_nl_bridge'` to `ai_interaction`'s
 * `interaction_type` CHECK list - `NlAnalyticsBridgeService.translateQuestion`/
 * `generateAnswer` (Module 10's first inbound gRPC surface, called by
 * Module 09's `askAnalyticsQuestion`) each persist their own `AiInteraction`
 * row under this one new type, distinguished from each other by
 * `input_context.step` (`'translate_question'` | `'generate_answer'`) rather
 * than a second new type - both are the same feature's two LLM calls, same
 * "one CHECK-list value per feature, not per LLM call" precedent `nl_query`
 * already set for `askQuestion`. Additive migration, same convention as
 * `AiProviderConfigGeminiOllamaSupport` (the Phase 2 `InitialAiLayerSchema`
 * migration is never edited after landing).
 */
export class AiInteractionAnalyticsNlBridgeType1700009800000 implements MigrationInterface {
  name = 'AiInteractionAnalyticsNlBridgeType1700009800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_interaction
        DROP CONSTRAINT ai_interaction_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_interaction
        ADD CONSTRAINT ai_interaction_type_check CHECK (interaction_type IN (
          'forecast_explanation', 'schedule_explanation', 'reallocation_rationale',
          'nl_query', 'root_cause_analysis', 'analytics_nl_bridge'
        ));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_interaction
        DROP CONSTRAINT ai_interaction_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_interaction
        ADD CONSTRAINT ai_interaction_type_check CHECK (interaction_type IN (
          'forecast_explanation', 'schedule_explanation', 'reallocation_rationale',
          'nl_query', 'root_cause_analysis'
        ));
    `);
  }
}
