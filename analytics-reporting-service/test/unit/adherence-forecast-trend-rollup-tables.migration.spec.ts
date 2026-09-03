import { QueryRunner } from 'typeorm';
import { AdherenceForecastTrendRollupTables1700005000000 } from '../../src/database/migrations/1700005000000-AdherenceForecastTrendRollupTables';

/**
 * No live Postgres in this test run - same posture as `initial-analytics-
 * schema.migration.spec.ts`. Asserts the invariants Phase 2/ADR-0108 depend
 * on: RLS on both new tables (unlike `mv_lineage`, these carry real tenant
 * data), the idempotent-upsert unique keys the refresh jobs' `ON CONFLICT`
 * targets, and the SELECT-only grant to `agno_analytics_app` (writes go
 * through `agno_migrator`, per `RefreshModule`'s own doc comment).
 */
describe('AdherenceForecastTrendRollupTables1700005000000', () => {
  const TABLES = ['mv_adherence_trend_rollup', 'mv_forecast_accuracy_trend'];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new AdherenceForecastTrendRollupTables1700005000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates both tables in analytics_mv', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE analytics_mv\\.${table}`).test(s))).toBe(true);
    }
  });

  it('enables RLS with a tenant_isolation policy on both tables (ADR-0002) - unlike mv_lineage, these carry real tenant data', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE analytics_mv\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(
        statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON analytics_mv\\.${table}`).test(s)),
      ).toBe(true);
    }
  });

  it('mv_adherence_trend_rollup has the (tenant_id, period_type, period_start) upsert key the refresh job ON CONFLICTs against', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_adherence_trend_rollup/.test(s));
    expect(create).toMatch(
      /CONSTRAINT mv_adherence_trend_rollup_upsert_key\s+UNIQUE \(tenant_id, period_type, period_start\)/,
    );
  });

  it('mv_forecast_accuracy_trend has the (tenant_id, org_unit_id, period_start) upsert key the refresh job ON CONFLICTs against', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_forecast_accuracy_trend/.test(s));
    expect(create).toMatch(
      /CONSTRAINT mv_forecast_accuracy_trend_upsert_key\s+UNIQUE \(tenant_id, org_unit_id, period_start\)/,
    );
  });

  it('grants agno_analytics_app SELECT only on both tables - no INSERT/UPDATE/DELETE (writes go through agno_migrator)', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      const grant = statements.find((s) => new RegExp(`GRANT SELECT ON analytics_mv\\.${table}`).test(s));
      expect(grant).toBeDefined();
      expect(grant).toContain('agno_analytics_app');
      expect(grant).not.toMatch(/INSERT|UPDATE|DELETE/);
    }
  });

  it('amends mv_lineage.source_description for mv_adherence_trend_rollup to the tenant/period grain actually shipped', async () => {
    const statements = await runUp();
    const update = statements.find((s) => /UPDATE analytics_mv\.mv_lineage/.test(s));
    expect(update).toBeDefined();
  });

  it('down() drops both tables', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new AdherenceForecastTrendRollupTables1700005000000();
    await migration.down(queryRunner);
    for (const table of TABLES) {
      expect(statements.some((s) => new RegExp(`DROP TABLE IF EXISTS analytics_mv\\.${table}`).test(s))).toBe(true);
    }
  });
});
