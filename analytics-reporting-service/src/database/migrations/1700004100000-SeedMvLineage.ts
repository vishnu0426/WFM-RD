import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 1 (§0.6/§2.2/§3, ADR-0108): seeds `mv_lineage` with all
 * four planned materialized views' documentation - source tables/owning
 * modules, refresh cadence, and the query pattern each exists to serve -
 * before any of the four actually exist as a Postgres `MATERIALIZED VIEW`
 * object (`refreshed_at`/`data_as_of`/`last_run_status` all stay NULL until
 * Phase 2/3's refresh runner populates them for real). This is deliberate:
 * lineage is documented from day one, not backfilled once a view happens
 * to exist, per §2.2's own instruction.
 *
 * `refresh_cadence` is seeded `'daily'` for every view, including
 * `mv_adherence_trend_rollup`/`mv_forecast_accuracy_trend` which §3 flags
 * as *candidates* for hourly "if load testing supports it." No load test
 * has run yet (that is Phase 8's own deliverable) - seeding `'daily'` now
 * is the honest starting point, not a guess at a cadence nothing has
 * measured; Phase 8 revisits this per-view once real numbers exist, same
 * disclosed-placeholder posture as this platform's other seeded defaults
 * (e.g. `RetentionPolicy`'s Phase 7 seed).
 */
export class SeedMvLineage1700004100000 implements MigrationInterface {
  name = 'SeedMvLineage1700004100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{
      viewName: string;
      sourceDescription: string;
      sourceTables: Array<{ module: string; schema: string; table: string }>;
      queryPatternDescription: string;
    }> = [
      {
        viewName: 'mv_adherence_trend_rollup',
        sourceDescription:
          "Re-aggregates Module 08's employee-level AdherenceScore by org_unit/period for executive-level " +
          '(vs. employee-level) rollups. Single-source - built first (Phase 2) to validate the read-replica ' +
          'pattern before tackling a cross-module join.',
        sourceTables: [{ module: 'module-08', schema: 'compliance', table: 'adherence_score' }],
        queryPatternDescription:
          'Executive dashboard adherence trend widget and metricQuery(metricName: "adherence_trend") - a ' +
          'bounded recent-period (e.g. last 12 months) read, never a full-history scan (§3).',
      },
      {
        viewName: 'mv_forecast_accuracy_trend',
        sourceDescription:
          "Reads directly from Module 03's ForecastAccuracyLog. Single-source - built alongside " +
          'mv_adherence_trend_rollup in Phase 2, same simplest-first ordering (§8 Phase 2).',
        sourceTables: [{ module: 'module-03', schema: 'forecasting', table: 'forecast_accuracy_log' }],
        queryPatternDescription:
          'Executive dashboard forecast-accuracy trend widget and metricQuery(metricName: "forecast_accuracy_trend").',
      },
      {
        viewName: 'mv_cost_vs_budget',
        sourceDescription:
          "Joins Module 02's employee cost-center attribution, Module 04's ShiftAssignment actual hours, and " +
          "Module 06's overtime/leave-driven cost impact - the genuinely multi-source aggregate this module's own " +
          "materialized-view mechanism exists for (§0.6), since no single owning module's table answers " +
          '"actual labor cost vs. budget" alone. Built in Phase 3, after the single-source views above prove the pattern.',
        sourceTables: [
          { module: 'module-02', schema: 'org', table: 'employees' },
          { module: 'module-04', schema: 'scheduling', table: 'shift_assignments' },
          { module: 'module-06', schema: 'attendance_leave', table: 'leave_requests' },
        ],
        queryPatternDescription:
          'Executive cost-vs-budget dashboard widget - an org-unit-scoped, bounded-date-range read (§3), the ' +
          "canonical example of a query the source spec's ClickHouse design existed to serve without hitting " +
          "every owning module's own primary (ADR-0108).",
      },
      {
        viewName: 'mv_attrition_by_site',
        sourceDescription:
          "Joins Module 02's Employee.termination_date and OrgUnit for site-level attrition. Built in Phase 3 " +
          'alongside mv_cost_vs_budget.',
        sourceTables: [
          { module: 'module-02', schema: 'org', table: 'employees' },
          { module: 'module-02', schema: 'org', table: 'org_units' },
        ],
        queryPatternDescription: 'Executive attrition-by-site dashboard widget, org-unit-scoped.',
      },
    ];

    for (const row of rows) {
      await queryRunner.query(
        `
        INSERT INTO analytics_mv.mv_lineage
          (view_name, source_description, source_tables, refresh_cadence, query_pattern_description, created_at)
        VALUES ($1, $2, $3::jsonb, 'daily', $4, now());
        `,
        [row.viewName, row.sourceDescription, JSON.stringify(row.sourceTables), row.queryPatternDescription],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM analytics_mv.mv_lineage
      WHERE view_name IN (
        'mv_adherence_trend_rollup', 'mv_forecast_accuracy_trend', 'mv_cost_vs_budget', 'mv_attrition_by_site'
      );
    `);
  }
}
