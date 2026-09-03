import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 08 Phase 1 (§2, §5a, §5b, ADR-0093/0094/0095/0096): the full §2.1
 * entity set plus the two closing-a-flagged-gap additions
 * (`RuleChangeImpactPreview` §5a, `RetentionPolicy` §5b) in one migration, in
 * the new `compliance` schema. Reuses Module 01's `app.current_tenant_id`
 * RLS convention (ADR-0002) and the shared-database/new-schema/new-role
 * pattern (ADR-0017/0052/0066/0073/0083, restated here in ADR-0093)
 * unchanged. Enum-typed columns are `varchar` + `CHECK`, not native Postgres
 * `ENUM` (ADR-0003).
 *
 * Two tables deliberately deviate from the uniform "tenant-scoped, `SELECT,
 * INSERT, UPDATE`" shape every other table in this migration follows:
 *
 * - `compliance_rule`/`retention_policy` have a **nullable** `tenant_id`
 *   (§2.2 rule 3, §5b): `NULL` means "platform-default row, visible to every
 *   tenant." The uniform `tenant_isolation` policy every other table gets
 *   would silently hide those rows from every tenant (`tenant_id = <this
 *   tenant>` never matches `NULL`), so both tables get their own
 *   `USING (tenant_id = <this tenant> OR tenant_id IS NULL)` /
 *   `WITH CHECK (tenant_id = <this tenant>)` policy instead - a tenant
 *   connection can always *read* the platform default plus its own
 *   overrides, but can never *write* a `NULL`-tenant row itself. See
 *   ADR-0095 and this migration's own inline comments for why writing a
 *   platform-default row is deliberately left as an unsolved, flagged
 *   problem for whichever phase first needs it (Phase 2's
 *   `createComplianceRule`).
 * - `compliance_report` is granted `DELETE` in addition to `SELECT, INSERT,
 *   UPDATE` - the one exception to this platform's "no DELETE anywhere"
 *   convention restated in ADR-0073/0083 - because §5b's retention/lifecycle
 *   job (Phase 7) is a real, scheduled row-level delete (guarded by
 *   `legal_hold`), not a status-column transition. See ADR-0096 for why this
 *   module chose row-level delete over Module 05's ADR-0066 partition-drop
 *   precedent.
 */
export class InitialComplianceSchema1700003000000 implements MigrationInterface {
  name = 'InitialComplianceSchema1700003000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS compliance;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // adherence_score (§2.1, §2.2 rule 1, §2.2 rule 4)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.adherence_score (
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        employee_id               uuid NOT NULL,
        period_type               varchar(10) NOT NULL,
        period_start              timestamptz NOT NULL,
        period_end                timestamptz NOT NULL,
        adherent_seconds          integer NOT NULL,
        total_scheduled_seconds   integer NOT NULL,
        adherence_pct             numeric(5,2) NOT NULL,
        major_deviation_count     integer NOT NULL DEFAULT 0,
        computed_at               timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT adherence_score_period_type_check
          CHECK (period_type IN ('shift', 'day', 'week', 'month')),
        CONSTRAINT adherence_score_period_range_check CHECK (period_end >= period_start),
        CONSTRAINT adherence_score_seconds_non_negative_check
          CHECK (adherent_seconds >= 0 AND total_scheduled_seconds >= 0),
        CONSTRAINT adherence_score_pct_range_check CHECK (adherence_pct >= 0 AND adherence_pct <= 100),
        -- §2.2 rule 4 (idempotent/resumable rollup): re-running a rollup job
        -- for the same employee+period must UPSERT this exact row, never a
        -- blind INSERT that would duplicate it. This unique key is the ON
        -- CONFLICT target Phase 3's rollup job writes against.
        CONSTRAINT adherence_score_upsert_key
          UNIQUE (tenant_id, employee_id, period_type, period_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_adherence_score_tenant_employee_period
      ON compliance.adherence_score (tenant_id, employee_id, period_type, period_start DESC);
    `);

    // -----------------------------------------------------------------------
    // occupancy_record (§2.1, §2.2 rule 4)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.occupancy_record (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        org_unit_id           uuid NOT NULL,
        interval_start        timestamptz NOT NULL,
        talk_time_seconds     integer NOT NULL DEFAULT 0,
        acw_seconds           integer NOT NULL DEFAULT 0,
        available_seconds     integer NOT NULL DEFAULT 0,
        occupancy_pct         numeric(5,2) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT occupancy_record_seconds_non_negative_check
          CHECK (talk_time_seconds >= 0 AND acw_seconds >= 0 AND available_seconds >= 0),
        CONSTRAINT occupancy_record_pct_range_check CHECK (occupancy_pct >= 0 AND occupancy_pct <= 100),
        CONSTRAINT occupancy_record_upsert_key UNIQUE (tenant_id, org_unit_id, interval_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_occupancy_record_tenant_org_unit_interval
      ON compliance.occupancy_record (tenant_id, org_unit_id, interval_start DESC);
    `);

    // -----------------------------------------------------------------------
    // shrinkage_record (§2.1, §2.2 rule 4)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.shrinkage_record (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        org_unit_id          uuid NOT NULL,
        interval_start       timestamptz NOT NULL,
        shrinkage_category   varchar(20) NOT NULL,
        shrinkage_pct        numeric(5,2) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT shrinkage_record_category_check
          CHECK (shrinkage_category IN ('leave', 'training', 'meeting', 'break_overage', 'absence', 'other')),
        CONSTRAINT shrinkage_record_pct_range_check CHECK (shrinkage_pct >= 0 AND shrinkage_pct <= 100),
        CONSTRAINT shrinkage_record_upsert_key
          UNIQUE (tenant_id, org_unit_id, interval_start, shrinkage_category)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_shrinkage_record_tenant_org_unit_interval
      ON compliance.shrinkage_record (tenant_id, org_unit_id, interval_start DESC);
    `);

    // -----------------------------------------------------------------------
    // compliance_rule (§2.1, §2.2 rules 2/3, §5a, ADR-0095)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.compliance_rule (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid,
        jurisdiction             varchar(10) NOT NULL,
        rule_type                varchar(30) NOT NULL,
        definition               jsonb NOT NULL,
        effective_from           date NOT NULL,
        effective_to             date,
        version                  integer NOT NULL DEFAULT 1,
        citation                 text NOT NULL,
        status                   varchar(20) NOT NULL DEFAULT 'pending_review',
        activation_delay_until   timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        activated_at             timestamptz,
        PRIMARY KEY (id),
        CONSTRAINT compliance_rule_rule_type_check CHECK (rule_type IN (
          'overtime_threshold', 'rest_period_minimum', 'max_consecutive_days', 'break_requirement', 'union_rule'
        )),
        -- §5a: createComplianceRule lands here, never active on write;
        -- activateComplianceRule is the only path to 'active'.
        CONSTRAINT compliance_rule_status_check
          CHECK (status IN ('pending_review', 'active', 'superseded', 'rejected')),
        -- §2.2 rule 2: "mandatory and non-empty ... enforced at the
        -- schema/validation level, not just a UI form field convention." A
        -- rule without a legal citation is structurally impossible to
        -- create, the same "can't violate it even if application code has a
        -- bug" posture as ADR-0054/attendance-leave's backdated-reason check.
        CONSTRAINT compliance_rule_citation_required_check CHECK (btrim(citation) <> ''),
        CONSTRAINT compliance_rule_effective_range_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
      );
    `);
    // GetActiveRule(jurisdiction, ruleType, asOfDate)'s read path (§3.3) -
    // Module 02/04's gRPC caller, wired in Phase 4.
    await queryRunner.query(`
      CREATE INDEX idx_compliance_rule_jurisdiction_type_tenant_effective
      ON compliance.compliance_rule (jurisdiction, rule_type, tenant_id, effective_from DESC);
    `);
    // §2.2 rule 3's versioning invariant, split across two partial unique
    // indexes because a plain UNIQUE(tenant_id, jurisdiction, rule_type,
    // version) would treat every NULL tenant_id as distinct from every other
    // (Postgres NULL != NULL in a unique constraint) and silently fail to
    // catch two colliding platform-default versions.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_compliance_rule_platform_default_version
      ON compliance.compliance_rule (jurisdiction, rule_type, version)
      WHERE tenant_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_compliance_rule_tenant_version
      ON compliance.compliance_rule (tenant_id, jurisdiction, rule_type, version)
      WHERE tenant_id IS NOT NULL;
    `);
    // §5a: the admin's pending-review queue.
    await queryRunner.query(`
      CREATE INDEX idx_compliance_rule_tenant_status
      ON compliance.compliance_rule (tenant_id, status)
      WHERE status = 'pending_review';
    `);

    // -----------------------------------------------------------------------
    // compliance_report (§2.1, §5b, ADR-0096)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.compliance_report (
        id                     uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        report_type            varchar(30) NOT NULL,
        date_range_start       date NOT NULL,
        date_range_end         date NOT NULL,
        org_unit_scope         uuid,
        status                 varchar(20) NOT NULL DEFAULT 'pending',
        generated_at           timestamptz NOT NULL DEFAULT now(),
        generated_by           uuid NOT NULL,
        file_uri               text,
        retention_expires_at   timestamptz NOT NULL,
        legal_hold             boolean NOT NULL DEFAULT false,
        PRIMARY KEY (id),
        CONSTRAINT compliance_report_type_check
          CHECK (report_type IN ('adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export')),
        -- Not in section 2.1's literal field list - added because
        -- POST /v1/compliance/reports (section 3.2) is explicitly async
        -- (returns a job_id), and without a status column there is no way
        -- to represent "job accepted, file_uri not populated yet" versus
        -- "generation failed." Same class of disclosed, non-retrofitted
        -- addition as attendance-leave's LeaveType.carryover_rules.
        CONSTRAINT compliance_report_status_check
          CHECK (status IN ('pending', 'completed', 'failed')),
        CONSTRAINT compliance_report_date_range_check CHECK (date_range_end >= date_range_start),
        -- file_uri is only ever non-null once generation actually succeeds.
        CONSTRAINT compliance_report_file_uri_completed_check
          CHECK (status <> 'completed' OR file_uri IS NOT NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_compliance_report_tenant_generated_at
      ON compliance.compliance_report (tenant_id, generated_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_compliance_report_tenant_type_date_range
      ON compliance.compliance_report (tenant_id, report_type, date_range_start);
    `);
    // §5b's lifecycle job (Phase 7) scans exactly this: everything past
    // expiry that isn't held. Partial index keeps that scan cheap regardless
    // of how many held/unexpired rows accumulate alongside it.
    await queryRunner.query(`
      CREATE INDEX idx_compliance_report_retention_expires_unheld
      ON compliance.compliance_report (retention_expires_at)
      WHERE NOT legal_hold;
    `);

    // -----------------------------------------------------------------------
    // rule_change_impact_preview (§5a - new entity, not in the source spec's
    // §2.1 literal list)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.rule_change_impact_preview (
        id                                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                         uuid NOT NULL,
        compliance_rule_id                uuid NOT NULL,
        simulated_against_schedule_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
        would_become_noncompliant_count   integer NOT NULL DEFAULT 0,
        affected_employee_ids             jsonb NOT NULL DEFAULT '[]'::jsonb,
        affected_org_unit_ids             jsonb NOT NULL DEFAULT '[]'::jsonb,
        generated_at                      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT rule_change_impact_preview_count_non_negative_check
          CHECK (would_become_noncompliant_count >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_change_impact_preview_rule_generated_at
      ON compliance.rule_change_impact_preview (compliance_rule_id, generated_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_change_impact_preview_tenant_generated_at
      ON compliance.rule_change_impact_preview (tenant_id, generated_at DESC);
    `);

    // -----------------------------------------------------------------------
    // retention_policy (§5b - new entity, not in the source spec's §2.1
    // literal list; same nullable-tenant_id platform-default shape as
    // compliance_rule, ADR-0095)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE compliance.retention_policy (
        id                          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                   uuid,
        jurisdiction                varchar(10) NOT NULL,
        retention_years             integer NOT NULL,
        applies_to_report_types     jsonb NOT NULL DEFAULT '["adherence_summary", "overtime_audit", "rest_period_audit", "regulator_export"]'::jsonb,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT retention_policy_years_positive_check CHECK (retention_years > 0)
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_retention_policy_platform_default
      ON compliance.retention_policy (jurisdiction)
      WHERE tenant_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_retention_policy_tenant
      ON compliance.retention_policy (tenant_id, jurisdiction)
      WHERE tenant_id IS NOT NULL;
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002, unchanged convention for the five
    // uniformly-tenant-scoped tables; compliance_rule/retention_policy get
    // their own nullable-tenant_id-aware policy below instead, ADR-0095)
    // -----------------------------------------------------------------------
    for (const table of [
      'adherence_score',
      'occupancy_record',
      'shrinkage_record',
      'compliance_report',
      'rule_change_impact_preview',
    ]) {
      await queryRunner.query(`ALTER TABLE compliance.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON compliance.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }
    for (const table of ['compliance_rule', 'retention_policy']) {
      await queryRunner.query(`ALTER TABLE compliance.${table} ENABLE ROW LEVEL SECURITY;`);
      // A tenant connection may READ the platform default (tenant_id IS
      // NULL) alongside its own override rows, but may never WRITE a
      // NULL-tenant row - see this file's own top-of-file doc comment and
      // ADR-0095. Platform-default rows are seeded/managed out of band
      // (Phase 2 flags exactly who/what is authorized to do this) until a
      // real platform-admin write path exists.
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON compliance.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr} OR tenant_id IS NULL)
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_compliance_app is the runtime role. compliance_report
    // alone gets DELETE (§5b's legal-hold-guarded lifecycle job, ADR-0096);
    // every other table follows this platform's usual no-DELETE convention.
    // No CREATE on the schema anywhere.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA compliance TO agno_compliance_app;`);
    for (const table of [
      'adherence_score',
      'occupancy_record',
      'shrinkage_record',
      'compliance_rule',
      'rule_change_impact_preview',
      'retention_policy',
    ]) {
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON compliance.${table} TO agno_compliance_app;`);
    }
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON compliance.compliance_report TO agno_compliance_app;`,
    );
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA compliance FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS compliance CASCADE;`);
  }
}
