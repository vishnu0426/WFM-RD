import { QueryRunner } from 'typeorm';
import { DashboardNameAndPlatformDefaultMetrics1700007000000 } from '../../src/database/migrations/1700007000000-DashboardNameAndPlatformDefaultMetrics';
import { SOURCE_VIEW_REGISTRY } from '../../src/analytics/source-view-registry';

describe('DashboardNameAndPlatformDefaultMetrics1700007000000', () => {
  async function runUp(): Promise<Array<{ sql: string; params?: unknown[] }>> {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const queryRunner = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
      }),
    } as unknown as QueryRunner;
    const migration = new DashboardNameAndPlatformDefaultMetrics1700007000000();
    await migration.up(queryRunner);
    return calls;
  }

  it('adds saved_report.name as NOT NULL', async () => {
    const calls = await runUp();
    expect(
      calls.some((c) => /ALTER TABLE analytics\.saved_report ADD COLUMN name varchar\(200\) NOT NULL/.test(c.sql)),
    ).toBe(true);
  });

  it('seeds exactly six platform-default (tenant_id NULL) metric_definition rows', async () => {
    const calls = await runUp();
    const inserts = calls.filter((c) => /INSERT INTO analytics\.metric_definition/.test(c.sql));
    expect(inserts).toHaveLength(6);
    for (const insert of inserts) {
      expect(insert.sql).toContain('VALUES (gen_random_uuid(), NULL,');
    }
  });

  it("every seeded metric's calculationDefinition.sourceView/valueColumn is a real entry in SOURCE_VIEW_REGISTRY (the query engine's own whitelist)", async () => {
    const calls = await runUp();
    const inserts = calls.filter((c) => /INSERT INTO analytics\.metric_definition/.test(c.sql));
    for (const insert of inserts) {
      const [, calculationDefinitionJson] = insert.params as string[];
      const { sourceView, valueColumn } = JSON.parse(calculationDefinitionJson);
      const spec = SOURCE_VIEW_REGISTRY[sourceView];
      expect(spec).toBeDefined();
      expect(spec.allowedValueColumns).toContain(valueColumn);
    }
  });

  it('seeds all six expected metric names, each with a valid §2.1 category', async () => {
    const calls = await runUp();
    const inserts = calls.filter((c) => /INSERT INTO analytics\.metric_definition/.test(c.sql));
    const seeded = inserts.map((c) => {
      const [name, , category] = c.params as string[];
      return { name, category };
    });
    expect(seeded.map((s) => s.name).sort()).toEqual(
      [
        'adherence_trend',
        'forecast_accuracy_mape',
        'scheduled_hours',
        'overtime_hours',
        'approved_leave_days',
        'attrition_terminations',
      ].sort(),
    );
    const validCategories = ['attendance', 'occupancy', 'cost', 'performance', 'forecast_accuracy'];
    for (const s of seeded) {
      expect(validCategories).toContain(s.category);
    }
  });

  it("seeds validated_at = now() and estimated_cost_tier = 'cheap' for every platform-authored metric", async () => {
    const calls = await runUp();
    const inserts = calls.filter((c) => /INSERT INTO analytics\.metric_definition/.test(c.sql));
    for (const insert of inserts) {
      expect(insert.sql).toContain("VALUES (gen_random_uuid(), NULL, $1, $2::jsonb, $3, now(), 'cheap', now(), now())");
    }
  });

  it('down() removes the seeded rows and drops the name column', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new DashboardNameAndPlatformDefaultMetrics1700007000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DELETE FROM analytics\.metric_definition/.test(s))).toBe(true);
    expect(statements.some((s) => /ALTER TABLE analytics\.saved_report DROP COLUMN name/.test(s))).toBe(true);
  });
});
