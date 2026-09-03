import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 10 Phase 1 (§2, §9 Phase 1): the full §2.1 entity set in the new
 * `ai_layer` schema. Reuses Module 01's `app.current_tenant_id` RLS
 * convention (ADR-0002) and the shared-database/new-schema/new-role pattern
 * every module since Module 03 has followed (ADR-0017/0052/0066/0073/0083/
 * 0093/0108, restated here in ADR-0113). Enum-typed columns are `varchar` +
 * `CHECK`, not native Postgres `ENUM` (ADR-0003).
 *
 * All three tables are uniformly tenant-scoped (`tenant_id` `NOT NULL`) -
 * unlike Module 08's `compliance_rule`/`retention_policy`, nothing in this
 * module has a "platform-default, visible to every tenant" row: an
 * unconfigured `AIGovernancePolicy.action_type` falls through to a
 * hardcoded platform default in application code (`suggest_only`, §3), not
 * a seeded `tenant_id IS NULL` database row - see ADR-0114.
 */
export class InitialAiLayerSchema1700009000000 implements MigrationInterface {
  name = 'InitialAiLayerSchema1700009000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS ai_layer;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // ai_interaction (§2.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_interaction (
        id                     uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        user_id                uuid,
        interaction_type       varchar(30) NOT NULL,
        input_context          jsonb NOT NULL,
        output_text            text,
        output_structured      jsonb,
        model_used             varchar(120) NOT NULL,
        confidence_indicator   numeric(3,2),
        degraded_mode          boolean NOT NULL DEFAULT false,
        created_at             timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT ai_interaction_type_check CHECK (interaction_type IN (
          'forecast_explanation', 'schedule_explanation', 'reallocation_rationale',
          'nl_query', 'root_cause_analysis'
        )),
        CONSTRAINT ai_interaction_confidence_range_check
          CHECK (confidence_indicator IS NULL OR (confidence_indicator >= 0 AND confidence_indicator <= 1)),
        -- §2.2 rule 4: confidence_indicator is "always surfaced," never
        -- silently absent for a real (non-degraded) LLM response - a
        -- degraded response (no LLM call made) is the only case where a
        -- caller has nothing to display, so NULL is only ever paired with
        -- degraded_mode = true here.
        CONSTRAINT ai_interaction_confidence_present_unless_degraded_check
          CHECK (degraded_mode OR confidence_indicator IS NOT NULL OR output_text IS NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_interaction_tenant_created_at
      ON ai_layer.ai_interaction (tenant_id, created_at DESC);
    `);
    // §0.5 FinOps: per-tenant AIInteraction volume against a plan/quota.
    await queryRunner.query(`
      CREATE INDEX idx_ai_interaction_tenant_type_created_at
      ON ai_layer.ai_interaction (tenant_id, interaction_type, created_at DESC);
    `);

    // -----------------------------------------------------------------------
    // ai_recommendation (§2.1, §2.2 rules 1/2)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_recommendation (
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        recommendation_type       varchar(60) NOT NULL,
        source_module             varchar(20) NOT NULL,
        rationale_text            text NOT NULL,
        -- §2.2 rule 2: required, non-nullable at the schema level - not an
        -- application-layer convention a caller could bypass.
        supporting_data_json      jsonb NOT NULL,
        status                    varchar(20) NOT NULL DEFAULT 'suggested',
        requires_human_approval   boolean NOT NULL,
        decided_by                uuid,
        ai_interaction_id         uuid NOT NULL REFERENCES ai_layer.ai_interaction (id),
        created_at                timestamptz NOT NULL DEFAULT now(),
        decided_at                timestamptz,
        PRIMARY KEY (id),
        CONSTRAINT ai_recommendation_source_module_check
          CHECK (source_module IN ('scheduling', 'forecasting', 'intraday')),
        CONSTRAINT ai_recommendation_status_check
          CHECK (status IN ('suggested', 'approved', 'rejected', 'auto_executed')),
        CONSTRAINT ai_recommendation_rationale_required_check CHECK (btrim(rationale_text) <> ''),
        -- A decision (approved/rejected/auto_executed) always carries a
        -- decided_at; 'suggested' never does yet.
        CONSTRAINT ai_recommendation_decided_at_consistency_check
          CHECK ((status = 'suggested') = (decided_at IS NULL))
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_recommendation_tenant_status_created_at
      ON ai_layer.ai_recommendation (tenant_id, status, created_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ai_recommendation_ai_interaction_id
      ON ai_layer.ai_recommendation (ai_interaction_id);
    `);

    // -----------------------------------------------------------------------
    // ai_governance_policy (§2.1, §3)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE ai_layer.ai_governance_policy (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        action_type             varchar(60) NOT NULL,
        autonomy_level          varchar(30) NOT NULL,
        risk_threshold_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at              timestamptz NOT NULL DEFAULT now(),
        updated_by              uuid NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ai_governance_policy_autonomy_level_check CHECK (autonomy_level IN (
          'suggest_only', 'approve_required', 'auto_execute_low_risk'
        )),
        -- One row per tenant per action_type (the 'default' sentinel is
        -- itself just a normal action_type value here - ADR-0114).
        CONSTRAINT ai_governance_policy_tenant_action_type_key UNIQUE (tenant_id, action_type)
      );
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002) - all three tables uniformly tenant-scoped.
    // -----------------------------------------------------------------------
    for (const table of ['ai_interaction', 'ai_recommendation', 'ai_governance_policy']) {
      await queryRunner.query(`ALTER TABLE ai_layer.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ai_layer.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_ai_app is the runtime role. Non-negotiable #1 (the LLM
    // never writes to operational tables) has no bearing here - this is
    // this module's OWN schema; the grant shape below is the ordinary
    // "no DELETE anywhere" convention every module but Module 08 follows,
    // not a governance control in itself (that's RLS + the application-layer
    // approval pathway, §3).
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA ai_layer TO agno_ai_app;`);
    for (const table of ['ai_interaction', 'ai_recommendation', 'ai_governance_policy']) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON ai_layer.${table} TO agno_ai_app;`);
    }
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ai_layer FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS ai_layer CASCADE;`);
  }
}
