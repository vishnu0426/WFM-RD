import { QueryRunner } from 'typeorm';
import { CostVsBudgetAttritionBySiteTables1700006000000 } from '../../src/database/migrations/1700006000000-CostVsBudgetAttritionBySiteTables';

describe('CostVsBudgetAttritionBySiteTables1700006000000', () => {
  const TABLES = ['mv_cost_vs_budget', 'mv_attrition_by_site'];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new CostVsBudgetAttritionBySiteTables1700006000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates both tables in analytics_mv', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE analytics_mv\\.${table}`).test(s))).toBe(true);
    }
  });

  it('mv_cost_vs_budget has no dollar-shaped column - only hours/days (ADR-0109)', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_cost_vs_budget/.test(s));
    expect(create).toMatch(/scheduled_hours\s+numeric/);
    expect(create).toMatch(/overtime_hours\s+numeric/);
    expect(create).toMatch(/approved_leave_days\s+numeric/);
    expect(create).not.toMatch(/\bcost\b|\bbudget\b|\bvariance\b/i);
  });

  it('mv_attrition_by_site has terminations_count only - no headcount/rate column', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_attrition_by_site/.test(s));
    expect(create).toMatch(/terminations_count\s+integer/);
    expect(create).not.toMatch(/headcount|attrition_rate|attrition_pct/i);
  });

  it('enables RLS on both tables (real tenant data, unlike mv_lineage)', async () => {
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

  it('mv_cost_vs_budget upserts on (tenant_id, cost_center, period_start)', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_cost_vs_budget/.test(s));
    expect(create).toMatch(/CONSTRAINT mv_cost_vs_budget_upsert_key\s+UNIQUE \(tenant_id, cost_center, period_start\)/);
  });

  it('mv_attrition_by_site upserts on (tenant_id, site_org_unit_id, period_start)', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics_mv\.mv_attrition_by_site/.test(s));
    expect(create).toMatch(
      /CONSTRAINT mv_attrition_by_site_upsert_key\s+UNIQUE \(tenant_id, site_org_unit_id, period_start\)/,
    );
  });

  it('grants agno_analytics_app SELECT only on both tables', async () => {
    const statements = await runUp();
    for (const table of TABLES) {
      const grant = statements.find((s) => new RegExp(`GRANT SELECT ON analytics_mv\\.${table}`).test(s));
      expect(grant).toBeDefined();
      expect(grant).toContain('agno_analytics_app');
      expect(grant).not.toMatch(/INSERT|UPDATE|DELETE/);
    }
  });

  it("amends mv_lineage source_description for both views, and mv_cost_vs_budget's explicitly disclaims a dollar figure", async () => {
    const statements = await runUp();
    const updates = statements.filter((s) => /UPDATE analytics_mv\.mv_lineage/.test(s));
    expect(updates).toHaveLength(2);
  });

  it('down() drops both tables', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new CostVsBudgetAttritionBySiteTables1700006000000();
    await migration.down(queryRunner);
    for (const table of TABLES) {
      expect(statements.some((s) => new RegExp(`DROP TABLE IF EXISTS analytics_mv\\.${table}`).test(s))).toBe(true);
    }
  });
});
