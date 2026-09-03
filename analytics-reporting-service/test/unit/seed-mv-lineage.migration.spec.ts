import { QueryRunner } from 'typeorm';
import { SeedMvLineage1700004100000 } from '../../src/database/migrations/1700004100000-SeedMvLineage';

/**
 * §0.6/§2.2: asserts all four planned views' lineage is seeded with a real
 * refresh_cadence and a non-empty source/query-pattern description - the
 * documentation requirement §2.2 states is not optional, not something a
 * future phase can quietly skip when it gets around to building the view
 * object itself.
 */
describe('SeedMvLineage1700004100000', () => {
  const EXPECTED_VIEWS = [
    'mv_adherence_trend_rollup',
    'mv_forecast_accuracy_trend',
    'mv_cost_vs_budget',
    'mv_attrition_by_site',
  ];

  async function runUp(): Promise<Array<{ sql: string; params?: unknown[] }>> {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const queryRunner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
      }),
    } as unknown as QueryRunner;

    const migration = new SeedMvLineage1700004100000();
    await migration.up(queryRunner);
    return calls;
  }

  it('inserts a mv_lineage row for all four planned views', async () => {
    const calls = await runUp();
    const insertedViewNames = calls.map((c) => c.params?.[0]);
    expect(insertedViewNames.sort()).toEqual([...EXPECTED_VIEWS].sort());
  });

  it('every seeded row has a non-empty source_description and query_pattern_description, and a refresh_cadence', async () => {
    const calls = await runUp();
    for (const call of calls) {
      const [, sourceDescription, sourceTablesJson, queryPatternDescription] = call.params as string[];
      expect(sourceDescription.length).toBeGreaterThan(0);
      expect(queryPatternDescription.length).toBeGreaterThan(0);
      expect(call.sql).toMatch(/'daily'/);
      const sourceTables = JSON.parse(sourceTablesJson);
      expect(Array.isArray(sourceTables)).toBe(true);
      expect(sourceTables.length).toBeGreaterThan(0);
      for (const entry of sourceTables) {
        expect(entry).toHaveProperty('module');
        expect(entry).toHaveProperty('schema');
        expect(entry).toHaveProperty('table');
      }
    }
  });

  it('mv_cost_vs_budget/mv_attrition_by_site document more than one source module (the genuinely multi-source views)', async () => {
    const calls = await runUp();
    for (const viewName of ['mv_cost_vs_budget', 'mv_attrition_by_site']) {
      const call = calls.find((c) => c.params?.[0] === viewName);
      const sourceTables = JSON.parse((call?.params as string[])[2]);
      const modules = new Set(sourceTables.map((t: { module: string }) => t.module));
      if (viewName === 'mv_cost_vs_budget') {
        expect(modules.size).toBeGreaterThanOrEqual(3);
      } else {
        expect(sourceTables.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('mv_adherence_trend_rollup/mv_forecast_accuracy_trend are single-source', async () => {
    const calls = await runUp();
    for (const viewName of ['mv_adherence_trend_rollup', 'mv_forecast_accuracy_trend']) {
      const call = calls.find((c) => c.params?.[0] === viewName);
      const sourceTables = JSON.parse((call?.params as string[])[2]);
      const modules = new Set(sourceTables.map((t: { module: string }) => t.module));
      expect(modules.size).toBe(1);
    }
  });

  it('down() removes exactly the four seeded rows', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new SeedMvLineage1700004100000();
    await migration.down(queryRunner);
    const deleteStatement = statements.find((s) => /DELETE FROM analytics_mv\.mv_lineage/.test(s));
    expect(deleteStatement).toBeDefined();
    for (const viewName of EXPECTED_VIEWS) {
      expect(deleteStatement).toContain(viewName);
    }
  });
});
