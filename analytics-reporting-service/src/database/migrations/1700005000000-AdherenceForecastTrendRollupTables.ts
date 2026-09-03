import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 2 (§8 Phase 2, ADR-0108): the two single-source
 * materialized-view *tables* `mv_lineage` already carries lineage for -
 * `mv_adherence_trend_rollup` (re-aggregates Module 08's `compliance.
 * adherence_score`) and `mv_forecast_accuracy_trend` (re-aggregates Module
 * 03's `forecasting.forecast_accuracy_log`). "Materialized view" in the
 * spec's conceptual sense, not Postgres's `CREATE MATERIALIZED VIEW`
 * syntax - these are plain, idempotent-upsert tables in `analytics_mv`,
 * the same rollup-table pattern every prior module's own derived-data
 * table already uses (ADR-0066/0093), populated by the refresh jobs this
 * phase adds rather than a Postgres-native `REFRESH MATERIALIZED VIEW`
 * (which would have to run against the primary and read its source table
 * from the primary too, undoing the entire point of reading from the
 * replica - see this phase's own design doc).
 *
 * Both tables carry a real `tenant_id` and get the platform's ordinary
 * RLS `tenant_isolation` policy (ADR-0002) - unlike `mv_lineage` (schema
 * metadata, no tenant data), these two hold real per-tenant derived
 * numbers. `agno_analytics_app` is granted `SELECT` only (Phase 4's live
 * serving reads, not used yet) - `agno_migrator` (the schema owner) is who
 * writes them, exactly Module 08's own `MIGRATOR_PG_POOL` precedent for a
 * job that touches many tenants' rows in one tick and cannot practically
 * flip `app.current_tenant_id` per row.
 */
export class AdherenceForecastTrendRollupTables1700005000000 implements MigrationInterface {
  name = 'AdherenceForecastTrendRollupTables1700005000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // mv_adherence_trend_rollup - re-aggregates compliance.adherence_score
    // across employees, grouped by the SAME (tenant_id, period_type,
    // period_start, period_end) triple Module 08's own rollup already
    // computed (ADR-0099) - this table never re-derives a day/week/month
    // boundary itself, it only re-aggregates across employees within a
    // boundary Module 08 already decided. No org_unit_id: adherence_score
    // has none (confirmed against the real table, not assumed from §2.2's
    // prose) - an org-unit breakdown would need a cross-module join to
    // Module 02's org.employees, which is out of scope for this
    // single-source phase (Phase 3's own genuinely-multi-source views are
    // where that kind of join belongs). mv_lineage's seeded
    // source_description said "by org_unit/period" (§2.2's own framing,
    // written in Phase 1 before this table's actual grain was implemented
    // against the real schema) - corrected below to the tenant/period
    // grain this phase actually ships, same "amend once implementation
    // surfaces the real shape" posture as ADR-0098/0099.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_adherence_trend_rollup (
        id                            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                     uuid NOT NULL,
        period_type                   varchar(10) NOT NULL,
        period_start                  timestamptz NOT NULL,
        period_end                    timestamptz NOT NULL,
        avg_adherence_pct             numeric(5,2) NOT NULL,
        total_major_deviation_count   integer NOT NULL DEFAULT 0,
        employee_count                integer NOT NULL,
        computed_at                   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_adherence_trend_rollup_period_type_check
          CHECK (period_type IN ('shift', 'day', 'week', 'month')),
        CONSTRAINT mv_adherence_trend_rollup_period_range_check CHECK (period_end >= period_start),
        CONSTRAINT mv_adherence_trend_rollup_pct_range_check
          CHECK (avg_adherence_pct >= 0 AND avg_adherence_pct <= 100),
        CONSTRAINT mv_adherence_trend_rollup_counts_non_negative_check
          CHECK (total_major_deviation_count >= 0 AND employee_count >= 0),
        -- The refresh job's own ON CONFLICT target (§2.2 rule 4's
        -- idempotent/resumable requirement, restated for this table).
        CONSTRAINT mv_adherence_trend_rollup_upsert_key
          UNIQUE (tenant_id, period_type, period_start)
      );
    `);
    // §3: an executive dashboard querying "last 12 months" reads this,
    // never a full-history scan.
    await queryRunner.query(`
      CREATE INDEX idx_mv_adherence_trend_rollup_tenant_period
      ON analytics_mv.mv_adherence_trend_rollup (tenant_id, period_type, period_start DESC);
    `);

    // -----------------------------------------------------------------------
    // mv_forecast_accuracy_trend - re-aggregates
    // forecasting.forecast_accuracy_log (which has no pre-existing
    // period bucketing of its own - it is per-evaluation rows keyed by
    // evaluated_at) into daily (tenant_id, org_unit_id) buckets. The
    // refresh job computes period_start via `date_trunc('day', ...)` on a
    // connection with its session timezone fixed to UTC (not the
    // per-employee-timezone `AT TIME ZONE` resolution ADR-0099 built for
    // Module 08's own rollup) - a disclosed simplification, since nothing
    // in ForecastAccuracyLog carries a tenant/org-unit timezone to
    // resolve against in the first place, same "UTC calendar day" posture
    // ADR-0098's first cut accepted before ADR-0099 found a real
    // per-employee timezone to use for Module 08's own table specifically.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_forecast_accuracy_trend (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        org_unit_id       uuid NOT NULL,
        period_start      timestamptz NOT NULL,
        period_end        timestamptz NOT NULL,
        avg_mape          numeric(10,6),
        avg_bias          numeric(10,6),
        forecast_count    integer NOT NULL,
        computed_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_forecast_accuracy_trend_period_range_check CHECK (period_end >= period_start),
        CONSTRAINT mv_forecast_accuracy_trend_count_non_negative_check CHECK (forecast_count >= 0),
        CONSTRAINT mv_forecast_accuracy_trend_upsert_key
          UNIQUE (tenant_id, org_unit_id, period_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mv_forecast_accuracy_trend_tenant_org_unit_period
      ON analytics_mv.mv_forecast_accuracy_trend (tenant_id, org_unit_id, period_start DESC);
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002) - both tables carry real tenant data.
    // -----------------------------------------------------------------------
    for (const table of ['mv_adherence_trend_rollup', 'mv_forecast_accuracy_trend']) {
      await queryRunner.query(`ALTER TABLE analytics_mv.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON analytics_mv.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_analytics_app gets SELECT only (Phase 4's live serving
    // reads; not called yet). The refresh job writes as agno_migrator (the
    // schema owner, bypassing RLS the same way Module 08's rollup jobs do
    // via MIGRATOR_PG_POOL) - never agno_analytics_app, since these tables
    // are written cross-tenant in one tick.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT ON analytics_mv.mv_adherence_trend_rollup TO agno_analytics_app;`);
    await queryRunner.query(`GRANT SELECT ON analytics_mv.mv_forecast_accuracy_trend TO agno_analytics_app;`);

    // -----------------------------------------------------------------------
    // Correct mv_lineage's Phase-1-seeded source_description for
    // mv_adherence_trend_rollup to the tenant/period grain this phase
    // actually ships (no org_unit_id on the source table) - an amendment,
    // not a silent rewrite, same posture ADR-0099 documents for ADR-0098.
    // -----------------------------------------------------------------------
    await queryRunner.query(
      `
      UPDATE analytics_mv.mv_lineage
      SET source_description = $2
      WHERE view_name = $1;
      `,
      [
        'mv_adherence_trend_rollup',
        "Re-aggregates Module 08's employee-level AdherenceScore across employees, grouped by the same " +
          "(tenant_id, period_type, period_start, period_end) triple Module 08's own rollup already computed " +
          '(ADR-0099) - a tenant-level trend per period, not an org-unit breakdown: adherence_score carries no ' +
          'org_unit_id (confirmed against the real table in Phase 2), so a per-org-unit rollup would need a ' +
          "cross-module join to Module 02's org.employees, out of scope for this single-source phase. " +
          "Amended from Phase 1's seeded description (ADR-0108) once implementation surfaced the real source shape.",
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_adherence_trend_rollup;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_forecast_accuracy_trend;`);
  }
}
