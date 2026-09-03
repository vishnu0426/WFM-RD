import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 2 addendum (docs/adr/0117): a deliberate deviation from
 * §1's "Anthropic only, platform-wide" default - each tenant brings their
 * own LLM provider/model/API key. Additive migration (the Phase 1 initial
 * migration is never edited after landing, same convention every other
 * module's own multi-migration history follows, e.g.
 * attendance-leave-service's 1700000700000/0800000/0900000).
 */
export class AiProviderConfigTable1700009100000 implements MigrationInterface {
  name = 'AiProviderConfigTable1700009100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_provider_config (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        provider              varchar(20) NOT NULL,
        model                 varchar(120) NOT NULL,
        -- AES-256-GCM ciphertext (base64: iv || authTag || ciphertext) -
        -- see AiProviderCredentialCipherService. Never returned by any
        -- query at the application layer (write-only after configuration,
        -- ADR-0046's oauth_clients precedent) - RLS/grants alone don't
        -- enforce that; the GraphQL resolver never selects/exposes it.
        encrypted_api_key     text NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        updated_by            uuid,
        PRIMARY KEY (id),
        CONSTRAINT ai_provider_config_provider_check CHECK (provider IN ('anthropic', 'openai')),
        -- One provider config per tenant (v1 - not per action_type/interaction_type).
        CONSTRAINT ai_provider_config_tenant_key UNIQUE (tenant_id)
      );
    `);

    await queryRunner.query(`ALTER TABLE ai_layer.ai_provider_config ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON ai_layer.ai_provider_config FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON ai_layer.ai_provider_config TO agno_ai_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ai_layer.ai_provider_config;`);
  }
}
