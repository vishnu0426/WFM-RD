import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 09 Phase 4 (§4, §8 Phase 4): two additive changes needed by the
 * metric query engine and dashboard/report builder this phase ships.
 *
 * 1. `saved_report.name` - §4.1's `Dashboard` GraphQL type has a `name`
 *    field, but §2.1's own `SavedReport` DDL never listed one (`config`'s
 *    own field list is "metrics, dimensions, filters, chart type" - no
 *    name). Added now as a plain `NOT NULL` column (no default needed -
 *    no request path has ever written a `saved_report` row before this
 *    phase, confirmed by this table having zero rows since Phase 1),
 *    same class of structurally-obvious addition as `saved_report_schedule_cron_scoped_check`.
 * 2. Six platform-default (`tenant_id = NULL`) `MetricDefinition` rows,
 *    one per column this module's four materialized views can honestly
 *    back a `metricQuery`/BI-connector read from. `calculationDefinition`
 *    is `{ sourceView, valueColumn, dimensions }` - `MetricQueryEngineService`
 *    validates `sourceView`/`valueColumn` against its own hardcoded
 *    whitelist before building any SQL (never trusts this jsonb blindly,
 *    even for a platform-authored row) - the same validation boundary
 *    Phase 5's tenant-authored dry-run gate will also need, built once
 *    here rather than twice. `validatedAt = now()` and
 *    `estimatedCostTier = 'cheap'` are set directly for these six rows -
 *    platform-authored, vetted by this migration's own review, not routed
 *    through Phase 5's tenant-authored dry-run pipeline (that pipeline
 *    exists for metrics this platform did *not* author itself).
 */
export class DashboardNameAndPlatformDefaultMetrics1700007000000 implements MigrationInterface {
  name = 'DashboardNameAndPlatformDefaultMetrics1700007000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE analytics.saved_report ADD COLUMN name varchar(200) NOT NULL;`);

    const metrics: Array<{
      name: string;
      calculationDefinition: { sourceView: string; valueColumn: string; dimensions: string[] };
      category: string;
    }> = [
      {
        name: 'adherence_trend',
        calculationDefinition: {
          sourceView: 'mv_adherence_trend_rollup',
          valueColumn: 'avg_adherence_pct',
          dimensions: ['period_type'],
        },
        category: 'attendance',
      },
      {
        name: 'forecast_accuracy_mape',
        calculationDefinition: {
          sourceView: 'mv_forecast_accuracy_trend',
          valueColumn: 'avg_mape',
          dimensions: ['org_unit_id'],
        },
        category: 'forecast_accuracy',
      },
      {
        name: 'scheduled_hours',
        calculationDefinition: {
          sourceView: 'mv_cost_vs_budget',
          valueColumn: 'scheduled_hours',
          dimensions: ['cost_center'],
        },
        category: 'cost',
      },
      {
        name: 'overtime_hours',
        calculationDefinition: {
          sourceView: 'mv_cost_vs_budget',
          valueColumn: 'overtime_hours',
          dimensions: ['cost_center'],
        },
        category: 'cost',
      },
      {
        name: 'approved_leave_days',
        calculationDefinition: {
          sourceView: 'mv_cost_vs_budget',
          valueColumn: 'approved_leave_days',
          dimensions: ['cost_center'],
        },
        category: 'cost',
      },
      {
        // §2.1's category enum (attendance/occupancy/cost/performance/
        // forecast_accuracy) has no clean fit for attrition -
        // 'performance' is the least-bad choice, not a confident
        // taxonomic claim.
        name: 'attrition_terminations',
        calculationDefinition: {
          sourceView: 'mv_attrition_by_site',
          valueColumn: 'terminations_count',
          dimensions: ['site_org_unit_id'],
        },
        category: 'performance',
      },
    ];

    for (const metric of metrics) {
      await queryRunner.query(
        `
        INSERT INTO analytics.metric_definition
          (id, tenant_id, name, calculation_definition, category, validated_at, estimated_cost_tier, created_at, updated_at)
        VALUES (gen_random_uuid(), NULL, $1, $2::jsonb, $3, now(), 'cheap', now(), now());
        `,
        [metric.name, JSON.stringify(metric.calculationDefinition), metric.category],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      DELETE FROM analytics.metric_definition
      WHERE tenant_id IS NULL AND name IN (
        'adherence_trend', 'forecast_accuracy_mape', 'scheduled_hours',
        'overtime_hours', 'approved_leave_days', 'attrition_terminations'
      );
      `,
    );
    await queryRunner.query(`ALTER TABLE analytics.saved_report DROP COLUMN name;`);
  }
}
