import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frontend Phase 7 (`updateDashboard`, `DashboardService.updateDashboard`):
 * the dashboard builder's edit path replaces a dashboard's widget set by
 * deleting every existing `dashboard_widget` row for it and re-inserting
 * the input's list fresh (same "whole collection replace" shape
 * `CreateDashboardInputType` already uses for create). `InitialAnalyticsSchema`
 * only ever granted `agno_analytics_app` `SELECT, INSERT, UPDATE` on this
 * table (1700004000000, §2.1) - nothing before this phase ever needed to
 * remove a row, so `DELETE` was never granted. Caught live (real
 * `permission denied for table dashboard_widget`, not a guess) rather than
 * only against a unit test's mocked `EntityManager`, which cannot surface a
 * missing Postgres GRANT.
 */
export class GrantDashboardWidgetDelete1700009000000 implements MigrationInterface {
  name = 'GrantDashboardWidgetDelete1700009000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT DELETE ON analytics.dashboard_widget TO agno_analytics_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE DELETE ON analytics.dashboard_widget FROM agno_analytics_app;`);
  }
}
