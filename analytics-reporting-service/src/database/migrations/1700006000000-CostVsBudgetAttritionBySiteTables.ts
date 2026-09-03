import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 3 (§8 Phase 3, ADR-0108/ADR-0109): the two genuinely
 * multi-source materialized-view tables - `mv_cost_vs_budget` and
 * `mv_attrition_by_site`. Same "plain idempotent-upsert table, not a
 * Postgres `MATERIALIZED VIEW`" convention as Phase 2's tables, same
 * `agno_analytics_app`-`SELECT`-only / `agno_migrator`-writes split.
 *
 * `mv_cost_vs_budget` (ADR-0109): despite its name, holds **hours and
 * days, never a dollar figure** - `org.employees.cost_center` × `scheduling.
 * shift_assignments` durations × `attendance_leave.leave_request` approved
 * days. No `pay_rate`/`budget` column exists anywhere in this platform
 * (confirmed, not assumed - ADR-0109's own Context section) so no dollar
 * cost or dollar budget can be honestly computed here; this migration's
 * own column names (`scheduled_hours`/`overtime_hours`/`approved_leave_days`)
 * say exactly what is stored, not what the view's name might imply.
 *
 * `mv_attrition_by_site` reports `terminations_count` only -
 * `org.employees.termination_date` × the nearest `org.org_units` ancestor
 * of `type = 'site'` (via the `path` ltree column, reflexive - an employee
 * assigned directly to a site-type unit counts as that site). No
 * headcount/rate column: reconstructing a *historical* point-in-time
 * headcount (the denominator a real attrition *rate* needs) would require
 * `org.employee_history`, out of scope for this phase - name the gap,
 * don't fabricate a rate from today's headcount pretending it applied to
 * a past period.
 */
export class CostVsBudgetAttritionBySiteTables1700006000000 implements MigrationInterface {
  name = 'CostVsBudgetAttritionBySiteTables1700006000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // mv_cost_vs_budget (ADR-0109) - hours/days by cost_center/month, never
    // a dollar figure.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_cost_vs_budget (
        id                     uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        cost_center            varchar(100) NOT NULL,
        period_start           timestamptz NOT NULL,
        period_end             timestamptz NOT NULL,
        scheduled_hours        numeric(10,2) NOT NULL DEFAULT 0,
        overtime_hours         numeric(10,2) NOT NULL DEFAULT 0,
        approved_leave_days    numeric(8,2) NOT NULL DEFAULT 0,
        computed_at            timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_cost_vs_budget_period_range_check CHECK (period_end >= period_start),
        CONSTRAINT mv_cost_vs_budget_non_negative_check
          CHECK (scheduled_hours >= 0 AND overtime_hours >= 0 AND approved_leave_days >= 0),
        CONSTRAINT mv_cost_vs_budget_upsert_key
          UNIQUE (tenant_id, cost_center, period_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mv_cost_vs_budget_tenant_cost_center_period
      ON analytics_mv.mv_cost_vs_budget (tenant_id, cost_center, period_start DESC);
    `);

    // -----------------------------------------------------------------------
    // mv_attrition_by_site - terminations_count by site/month.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE analytics_mv.mv_attrition_by_site (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        site_org_unit_id      uuid NOT NULL,
        period_start          timestamptz NOT NULL,
        period_end            timestamptz NOT NULL,
        terminations_count    integer NOT NULL DEFAULT 0,
        computed_at           timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT mv_attrition_by_site_period_range_check CHECK (period_end >= period_start),
        CONSTRAINT mv_attrition_by_site_count_non_negative_check CHECK (terminations_count >= 0),
        CONSTRAINT mv_attrition_by_site_upsert_key
          UNIQUE (tenant_id, site_org_unit_id, period_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mv_attrition_by_site_tenant_site_period
      ON analytics_mv.mv_attrition_by_site (tenant_id, site_org_unit_id, period_start DESC);
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002) - both carry real tenant data.
    // -----------------------------------------------------------------------
    for (const table of ['mv_cost_vs_budget', 'mv_attrition_by_site']) {
      await queryRunner.query(`ALTER TABLE analytics_mv.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON analytics_mv.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - SELECT only to agno_analytics_app (Phase 4); writes are
    // agno_migrator, same cross-tenant-batch reasoning as Phase 2's tables.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT ON analytics_mv.mv_cost_vs_budget TO agno_analytics_app;`);
    await queryRunner.query(`GRANT SELECT ON analytics_mv.mv_attrition_by_site TO agno_analytics_app;`);

    // -----------------------------------------------------------------------
    // Amend mv_lineage's Phase-1-seeded descriptions for both views to what
    // this phase actually ships (ADR-0109 for mv_cost_vs_budget's dollar-
    // figure gap specifically) - an amendment, not a silent rewrite, same
    // posture as Phase 2's own mv_lineage correction.
    // -----------------------------------------------------------------------
    await queryRunner.query(`UPDATE analytics_mv.mv_lineage SET source_description = $2 WHERE view_name = $1;`, [
      'mv_cost_vs_budget',
      "Joins Module 02's org.employees.cost_center, Module 04's scheduling.shift_assignments (scheduled/overtime " +
        "hours), and Module 06's attendance_leave.leave_request (approved leave days) - reports hours and days " +
        'by cost_center/month, NOT a dollar cost or dollar budget figure: no employee pay-rate and no budget-' +
        'allocation capability exists anywhere in this platform (confirmed by inspecting every schema, ADR-0109). ' +
        'Employees with no cost_center assigned are excluded, not attributed to a fabricated bucket. Leave days ' +
        "are calendar days attributed to a request's start month, not working-day-aware or split across a month " +
        'boundary - disclosed simplifications, not precision this data supports.',
    ]);
    await queryRunner.query(`UPDATE analytics_mv.mv_lineage SET source_description = $2 WHERE view_name = $1;`, [
      'mv_attrition_by_site',
      "Joins Module 02's org.employees.termination_date with the nearest org.org_units ancestor of type='site' " +
        '(via the path ltree column, reflexive) - reports terminations_count by site/month only. No headcount or ' +
        'rate: a real attrition rate needs a historical point-in-time headcount denominator, which would require ' +
        "org.employee_history and is out of scope for this phase - named, not fabricated from today's headcount.",
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_cost_vs_budget;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics_mv.mv_attrition_by_site;`);
  }
}
