import { QueryRunner } from 'typeorm';
import { InitialAnalyticsSchema1700004000000 } from '../../src/database/migrations/1700004000000-InitialAnalyticsSchema';

/**
 * No live Postgres in this test run (Phase 1 has no `test/integration/`
 * directory yet - same real, flagged follow-up every other service's own
 * Phase 1 checklist notes). This spec instead captures every SQL string the
 * migration's `up()` issues against a mock `QueryRunner` and asserts the
 * invariants §2/§2.2/ADR-0095/0108 depend on, so a future edit to this
 * migration can't silently drop the RLS policy on any table, the
 * nullable-tenant-id platform-default shape, the `data_as_of <=
 * refreshed_at` guarantee, or widen a grant past least-privilege without a
 * test failing.
 */
describe('InitialAnalyticsSchema1700004000000', () => {
  const UNIFORM_TENANT_TABLES = ['saved_report', 'dashboard_widget'];
  const NULLABLE_TENANT_TABLES = ['metric_definition'];
  const ANALYTICS_TABLES = [...UNIFORM_TENANT_TABLES, ...NULLABLE_TENANT_TABLES];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new InitialAnalyticsSchema1700004000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates the analytics and analytics_mv schemas and all four tables', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS analytics;/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS analytics_mv;/.test(s))).toBe(true);
    for (const table of ANALYTICS_TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE analytics\\.${table}`).test(s))).toBe(true);
    }
    expect(statements.some((s) => /CREATE TABLE analytics_mv\.mv_lineage/.test(s))).toBe(true);
  });

  it('enables RLS with a tenant_isolation policy on saved_report/dashboard_widget/metric_definition, but not mv_lineage', async () => {
    const statements = await runUp();
    for (const table of ANALYTICS_TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE analytics\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON analytics\\.${table}`).test(s))).toBe(
        true,
      );
    }
    expect(statements.some((s) => /mv_lineage ENABLE ROW LEVEL SECURITY/.test(s))).toBe(false);
    expect(statements.some((s) => /CREATE POLICY tenant_isolation ON analytics_mv\.mv_lineage/.test(s))).toBe(false);
  });

  it('§2.1/ADR-0095: metric_definition RLS reads the platform default but never writes it as null', async () => {
    const statements = await runUp();
    const policy = statements.find((s) => /CREATE POLICY tenant_isolation ON analytics\.metric_definition/.test(s));
    expect(policy).toBeDefined();
    expect(policy).toMatch(/USING \(tenant_id = current_setting\([^)]*\)::uuid OR tenant_id IS NULL\)/);
    expect(policy).toMatch(/WITH CHECK \(tenant_id = current_setting\([^)]*\)::uuid\)/);
    expect(policy).not.toMatch(/WITH CHECK \([^)]*IS NULL/);
  });

  it('§2.1: metric_definition name uniqueness is split into platform-default and tenant-scoped partial indexes', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX idx_metric_definition_platform_default_name[\s\S]*WHERE tenant_id IS NULL/.test(s),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX idx_metric_definition_tenant_name[\s\S]*WHERE tenant_id IS NOT NULL/.test(s),
      ),
    ).toBe(true);
  });

  it('saved_report.schedule_cron is only ever set for a scheduled_export', async () => {
    const statements = await runUp();
    const createReport = statements.find((s) => /CREATE TABLE analytics\.saved_report/.test(s));
    expect(createReport).toMatch(
      /CONSTRAINT saved_report_schedule_cron_scoped_check\s+CHECK \(schedule_cron IS NULL OR report_type = 'scheduled_export'\)/,
    );
  });

  it('dashboard_widget has real foreign keys to saved_report and metric_definition', async () => {
    const statements = await runUp();
    const createWidget = statements.find((s) => /CREATE TABLE analytics\.dashboard_widget/.test(s));
    expect(createWidget).toMatch(
      /CONSTRAINT dashboard_widget_dashboard_fk\s+FOREIGN KEY \(dashboard_id\) REFERENCES analytics\.saved_report \(id\)/,
    );
    expect(createWidget).toMatch(
      /CONSTRAINT dashboard_widget_metric_fk\s+FOREIGN KEY \(metric_id\) REFERENCES analytics\.metric_definition \(id\)/,
    );
  });

  it('§2.3 rule 1: mv_lineage.data_as_of can never be newer than refreshed_at', async () => {
    const statements = await runUp();
    const createLineage = statements.find((s) => /CREATE TABLE analytics_mv\.mv_lineage/.test(s));
    expect(createLineage).toMatch(
      /CONSTRAINT mv_lineage_data_as_of_not_after_refresh_check\s+CHECK \(data_as_of IS NULL OR refreshed_at IS NULL OR data_as_of <= refreshed_at\)/,
    );
  });

  it('ADR-0108: grants are least-privilege everywhere, no DELETE, no CREATE on either schema', async () => {
    const statements = await runUp();
    for (const table of ANALYTICS_TABLES) {
      const grant = statements.find((s) =>
        new RegExp(`GRANT .* ON analytics\\.${table} TO agno_analytics_app`).test(s),
      );
      expect(grant).toBeDefined();
      expect(grant).toContain('SELECT');
      expect(grant).toContain('INSERT');
      expect(grant).toContain('UPDATE');
      expect(grant).not.toContain('DELETE');
    }
    const lineageGrant = statements.find((s) => /GRANT .* ON analytics_mv\.mv_lineage TO agno_analytics_app/.test(s));
    expect(lineageGrant).toContain('SELECT');
    expect(lineageGrant).toContain('UPDATE');
    expect(lineageGrant).not.toContain('INSERT');
    expect(lineageGrant).not.toContain('DELETE');
    expect(statements.some((s) => /GRANT CREATE ON SCHEMA analytics/.test(s))).toBe(false);
    expect(statements.some((s) => /GRANT CREATE ON SCHEMA analytics_mv/.test(s))).toBe(false);
  });

  it('down() drops both schemas (rollback plan)', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new InitialAnalyticsSchema1700004000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS analytics CASCADE/.test(s))).toBe(true);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS analytics_mv CASCADE/.test(s))).toBe(true);
  });
});
