import { QueryRunner } from 'typeorm';
import { AnalyticsExportTable1700008000000 } from '../../src/database/migrations/1700008000000-AnalyticsExportTable';

describe('AnalyticsExportTable1700008000000', () => {
  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new AnalyticsExportTable1700008000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates analytics.analytics_export', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE TABLE analytics\.analytics_export/.test(s))).toBe(true);
  });

  it('file_uri is only allowed to be non-null once status is completed', async () => {
    const statements = await runUp();
    const create = statements.find((s) => /CREATE TABLE analytics\.analytics_export/.test(s));
    expect(create).toMatch(
      /CONSTRAINT analytics_export_file_uri_completed_check\s+CHECK \(status <> 'completed' OR file_uri IS NOT NULL\)/,
    );
  });

  it('enforces the idempotency key via a partial unique index on (tenant_id, idempotency_key)', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX idx_analytics_export_tenant_idempotency_key[\s\S]*WHERE idempotency_key IS NOT NULL/.test(
          s,
        ),
      ),
    ).toBe(true);
  });

  it('enables RLS (real tenant data, request-scoped, unlike the analytics_mv.mv_* tables)', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /ALTER TABLE analytics\.analytics_export ENABLE ROW LEVEL SECURITY/.test(s))).toBe(
      true,
    );
    expect(statements.some((s) => /CREATE POLICY tenant_isolation ON analytics\.analytics_export/.test(s))).toBe(true);
  });

  it('grants agno_analytics_app SELECT, INSERT, UPDATE - not agno_migrator (request-scoped CRUD, not a cross-tenant batch job)', async () => {
    const statements = await runUp();
    const grant = statements.find((s) => /GRANT .* ON analytics\.analytics_export TO agno_analytics_app/.test(s));
    expect(grant).toBeDefined();
    expect(grant).toContain('SELECT');
    expect(grant).toContain('INSERT');
    expect(grant).toContain('UPDATE');
    expect(grant).not.toContain('DELETE');
  });

  it('down() drops the table', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new AnalyticsExportTable1700008000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP TABLE IF EXISTS analytics\.analytics_export/.test(s))).toBe(true);
  });
});
