import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 9 (docs/adr/0132): SCD Type 2 history for
 * `ai_governance_policy` and `ai_provider_config`, matching Module 02's own
 * `org_unit_history`/`employee_history` pattern exactly (ADR-0009) - a
 * trigger-maintained, append-only companion table per live table, never
 * written by application code. Chosen over Module 04's `Policy` self-
 * versioning-in-place pattern (ADR-0006) because, like `OrgUnit`/`Employee`,
 * the live row is what every read path actually queries on the hot path
 * (`AiGovernancePolicyResolverService.resolve` on every recommendation,
 * `AiProviderConfigService.resolveForCall` on every LLM call) - history
 * here is a secondary audit trail, not a directly-addressable resource in
 * its own right the way a `Policy` version is.
 *
 * Additive migration (every prior migration in this module's history is
 * never edited after landing).
 */
export class AiGovernancePolicyAndProviderConfigHistory1700009600000 implements MigrationInterface {
  name = 'AiGovernancePolicyAndProviderConfigHistory1700009600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // ai_governance_policy_history - versions only on a change to
    // autonomy_level/risk_threshold_config (own copy of Module 02's
    // "only track meaningful column changes" convention, ADR-0009) - a
    // tenant resubmitting the same value is a no-op, not a new version.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ai_layer.fn_ai_governance_policy_history_track()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO ai_layer.ai_governance_policy_history (
            id, tenant_id, governance_policy_id, valid_from, valid_to,
            action_type, autonomy_level, risk_threshold_config, updated_by
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.updated_at, NULL,
            NEW.action_type, NEW.autonomy_level, NEW.risk_threshold_config, NEW.updated_by
          );
          RETURN NEW;
        END IF;

        IF NEW.autonomy_level IS DISTINCT FROM OLD.autonomy_level
           OR NEW.risk_threshold_config IS DISTINCT FROM OLD.risk_threshold_config THEN
          UPDATE ai_layer.ai_governance_policy_history
            SET valid_to = now()
            WHERE tenant_id = NEW.tenant_id AND governance_policy_id = NEW.id AND valid_to IS NULL;
          INSERT INTO ai_layer.ai_governance_policy_history (
            id, tenant_id, governance_policy_id, valid_from, valid_to,
            action_type, autonomy_level, risk_threshold_config, updated_by
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, now(), NULL,
            NEW.action_type, NEW.autonomy_level, NEW.risk_threshold_config, NEW.updated_by
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_governance_policy_history (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        governance_policy_id     uuid NOT NULL REFERENCES ai_layer.ai_governance_policy(id),
        valid_from               timestamptz NOT NULL,
        valid_to                 timestamptz,
        action_type              varchar(60) NOT NULL,
        autonomy_level           varchar(30) NOT NULL,
        risk_threshold_config    jsonb NOT NULL,
        updated_by               uuid,
        PRIMARY KEY (id),
        CONSTRAINT ai_governance_policy_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_governance_policy_history_tenant_policy
        ON ai_layer.ai_governance_policy_history (tenant_id, governance_policy_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_ai_governance_policy_history_one_open_version
        ON ai_layer.ai_governance_policy_history (tenant_id, governance_policy_id) WHERE valid_to IS NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ai_governance_policy_history AFTER INSERT OR UPDATE ON ai_layer.ai_governance_policy
      FOR EACH ROW EXECUTE FUNCTION ai_layer.fn_ai_governance_policy_history_track();
    `);

    // -----------------------------------------------------------------------
    // ai_provider_config_history - versions on EVERY update, not just a
    // change to a specific tracked column (a deliberate departure from
    // Module 02's convention, disclosed in ADR-0132): `encrypted_api_key`
    // uses a random IV per encryption (`AiProviderCredentialCipherService`),
    // so even re-submitting the byte-identical plaintext key produces a
    // different ciphertext - there is no reliable way to distinguish "the
    // key actually changed" from "the same key was re-encrypted" by
    // comparing column values, so every update is treated as a real
    // configuration-change event. `encrypted_api_key` itself is never
    // copied into history at all - keeping old encrypted keys around
    // indefinitely, even encrypted, needlessly expands blast radius if the
    // encryption key is ever compromised.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ai_layer.fn_ai_provider_config_history_track()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO ai_layer.ai_provider_config_history (
            id, tenant_id, provider_config_id, valid_from, valid_to,
            provider, model, base_url, updated_by
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.updated_at, NULL,
            NEW.provider, NEW.model, NEW.base_url, NEW.updated_by
          );
          RETURN NEW;
        END IF;

        UPDATE ai_layer.ai_provider_config_history
          SET valid_to = now()
          WHERE tenant_id = NEW.tenant_id AND provider_config_id = NEW.id AND valid_to IS NULL;
        INSERT INTO ai_layer.ai_provider_config_history (
          id, tenant_id, provider_config_id, valid_from, valid_to,
          provider, model, base_url, updated_by
        ) VALUES (
          gen_random_uuid(), NEW.tenant_id, NEW.id, now(), NULL,
          NEW.provider, NEW.model, NEW.base_url, NEW.updated_by
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_provider_config_history (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        provider_config_id   uuid NOT NULL REFERENCES ai_layer.ai_provider_config(id),
        valid_from           timestamptz NOT NULL,
        valid_to             timestamptz,
        provider             varchar(20) NOT NULL,
        model                varchar(120) NOT NULL,
        base_url             varchar(500),
        updated_by           uuid,
        PRIMARY KEY (id),
        CONSTRAINT ai_provider_config_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_provider_config_history_tenant_config
        ON ai_layer.ai_provider_config_history (tenant_id, provider_config_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_ai_provider_config_history_one_open_version
        ON ai_layer.ai_provider_config_history (tenant_id, provider_config_id) WHERE valid_to IS NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ai_provider_config_history AFTER INSERT OR UPDATE ON ai_layer.ai_provider_config
      FOR EACH ROW EXECUTE FUNCTION ai_layer.fn_ai_provider_config_history_track();
    `);

    // -----------------------------------------------------------------------
    // RLS + grants - same uniform tenant-scoping every ai_layer table uses
    // (ADR-0113), and the same append-only grant shape Module 02 uses for
    // its own history tables (ADR-0009): INSERT + a column-scoped
    // UPDATE (valid_to) only, no DELETE, ever.
    // -----------------------------------------------------------------------
    for (const table of ['ai_governance_policy_history', 'ai_provider_config_history']) {
      await queryRunner.query(`ALTER TABLE ai_layer.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ai_layer.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`GRANT SELECT, INSERT ON ai_layer.${table} TO agno_ai_app;`);
      await queryRunner.query(`GRANT UPDATE (valid_to) ON ai_layer.${table} TO agno_ai_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_ai_provider_config_history ON ai_layer.ai_provider_config;`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_ai_governance_policy_history ON ai_layer.ai_governance_policy;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS ai_layer.ai_provider_config_history;`);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_layer.ai_governance_policy_history;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ai_layer.fn_ai_provider_config_history_track();`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ai_layer.fn_ai_governance_policy_history_track();`);
  }
}
