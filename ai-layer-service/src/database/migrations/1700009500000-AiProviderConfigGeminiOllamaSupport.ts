import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 8 addendum (docs/adr/0129): adds `gemini`/`ollama` as
 * BYOK provider choices alongside `anthropic`/`openai` (docs/adr/0117).
 * Additive migration (the Phase 2 `AiProviderConfigTable` migration is
 * never edited after landing, same convention every prior addendum in this
 * module's own migration history follows).
 *
 * `encrypted_api_key` becomes nullable - `ollama` is typically a tenant's
 * own self-hosted, unauthenticated instance with no key at all;
 * `AiProviderConfigService.configure` still requires a real key for the
 * three cloud providers, enforced in application code, not this column's
 * own constraint. `base_url` is new, nullable, required only for `ollama`
 * (same application-level enforcement) - a self-hosted provider has no
 * fixed platform endpoint the way the three cloud providers do.
 */
export class AiProviderConfigGeminiOllamaSupport1700009500000 implements MigrationInterface {
  name = 'AiProviderConfigGeminiOllamaSupport1700009500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        DROP CONSTRAINT ai_provider_config_provider_check;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        ADD CONSTRAINT ai_provider_config_provider_check
        CHECK (provider IN ('anthropic', 'openai', 'gemini', 'ollama'));
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        ALTER COLUMN encrypted_api_key DROP NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        ADD COLUMN base_url varchar(500);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        DROP COLUMN base_url;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        ALTER COLUMN encrypted_api_key SET NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        DROP CONSTRAINT ai_provider_config_provider_check;
    `);
    await queryRunner.query(`
      ALTER TABLE ai_layer.ai_provider_config
        ADD CONSTRAINT ai_provider_config_provider_check
        CHECK (provider IN ('anthropic', 'openai'));
    `);
  }
}
