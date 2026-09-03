import { QueryRunner } from 'typeorm';
import { InitialComplianceSchema1700003000000 } from '../../src/database/migrations/1700003000000-InitialComplianceSchema';

/**
 * No live Postgres in this test run (Phase 1 has no `test/integration/`
 * directory yet - same real, flagged follow-up every other service's own
 * Phase 1 checklist notes). This spec instead captures every SQL string the
 * migration's `up()` issues against a mock `QueryRunner` and asserts the
 * invariants §2/§2.2/§5a/§5b/ADR-0093/0094/0095/0096 depend on, so a future
 * edit to this migration can't silently drop the citation guarantee, the RLS
 * policy on any table, the nullable-tenant-id platform-default shape, or
 * widen a grant past least-privilege without a test failing.
 */
describe('InitialComplianceSchema1700003000000', () => {
  const UNIFORM_TENANT_TABLES = [
    'adherence_score',
    'occupancy_record',
    'shrinkage_record',
    'compliance_report',
    'rule_change_impact_preview',
  ];
  const NULLABLE_TENANT_TABLES = ['compliance_rule', 'retention_policy'];
  const ALL_TABLES = [...UNIFORM_TENANT_TABLES, ...NULLABLE_TENANT_TABLES];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new InitialComplianceSchema1700003000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates the compliance schema and all seven tables', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS compliance/.test(s))).toBe(true);
    for (const table of ALL_TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE compliance\\.${table}`).test(s))).toBe(true);
    }
  });

  it('enables RLS with a tenant_isolation policy on every table (ADR-0002)', async () => {
    const statements = await runUp();
    for (const table of ALL_TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE compliance\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(
        statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON compliance\\.${table}`).test(s)),
      ).toBe(true);
    }
  });

  it('§2.2 rule 3/ADR-0095: compliance_rule/retention_policy RLS reads the platform default but never writes it as null', async () => {
    const statements = await runUp();
    for (const table of NULLABLE_TENANT_TABLES) {
      const policy = statements.find((s) =>
        new RegExp(`CREATE POLICY tenant_isolation ON compliance\\.${table}`).test(s),
      );
      expect(policy).toBeDefined();
      expect(policy).toMatch(/USING \(tenant_id = current_setting\([^)]*\)::uuid OR tenant_id IS NULL\)/);
      expect(policy).toMatch(/WITH CHECK \(tenant_id = current_setting\([^)]*\)::uuid\)/);
      expect(policy).not.toMatch(/WITH CHECK \([^)]*IS NULL/);
    }
  });

  it('§2.2 rule 2: a compliance_rule without a citation is structurally impossible', async () => {
    const statements = await runUp();
    const createRule = statements.find((s) => /CREATE TABLE compliance\.compliance_rule/.test(s));
    expect(createRule).toMatch(/citation\s+text NOT NULL/);
    expect(createRule).toMatch(/CONSTRAINT compliance_rule_citation_required_check CHECK \(btrim\(citation\) <> ''\)/);
  });

  it("§5a: compliance_rule defaults to status = 'pending_review', never active on creation", async () => {
    const statements = await runUp();
    const createRule = statements.find((s) => /CREATE TABLE compliance\.compliance_rule/.test(s));
    expect(createRule).toMatch(/status\s+varchar\(20\) NOT NULL DEFAULT 'pending_review'/);
  });

  it('§2.2 rule 3: compliance_rule version uniqueness is split into platform-default and tenant-scoped partial indexes', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX idx_compliance_rule_platform_default_version[\s\S]*WHERE tenant_id IS NULL/.test(s),
      ),
    ).toBe(true);
    expect(
      statements.some((s) =>
        /CREATE UNIQUE INDEX idx_compliance_rule_tenant_version[\s\S]*WHERE tenant_id IS NOT NULL/.test(s),
      ),
    ).toBe(true);
  });

  it('§0.5: adherence_score/occupancy_record/shrinkage_record carry an idempotent-upsert unique key (rollup jobs must be resumable)', async () => {
    const statements = await runUp();
    const createAdherence = statements.find((s) => /CREATE TABLE compliance\.adherence_score/.test(s));
    expect(createAdherence).toMatch(
      /CONSTRAINT adherence_score_upsert_key\s+UNIQUE \(tenant_id, employee_id, period_type, period_start\)/,
    );
    const createOccupancy = statements.find((s) => /CREATE TABLE compliance\.occupancy_record/.test(s));
    expect(createOccupancy).toMatch(
      /CONSTRAINT occupancy_record_upsert_key UNIQUE \(tenant_id, org_unit_id, interval_start\)/,
    );
    const createShrinkage = statements.find((s) => /CREATE TABLE compliance\.shrinkage_record/.test(s));
    expect(createShrinkage).toMatch(
      /CONSTRAINT shrinkage_record_upsert_key\s+UNIQUE \(tenant_id, org_unit_id, interval_start, shrinkage_category\)/,
    );
  });

  it('§2.2 rule 1: adherence_score has no view/on-read computed column - adherence_pct is a plain stored numeric', async () => {
    const statements = await runUp();
    const createAdherence = statements.find((s) => /CREATE TABLE compliance\.adherence_score/.test(s));
    expect(createAdherence).toMatch(/adherence_pct\s+numeric\(5,2\) NOT NULL/);
    expect(statements.some((s) => /CREATE (OR REPLACE )?VIEW/i.test(s))).toBe(false);
  });

  it('§5b: compliance_report.retention_expires_at is NOT NULL and legal_hold defaults to false', async () => {
    const statements = await runUp();
    const createReport = statements.find((s) => /CREATE TABLE compliance\.compliance_report/.test(s));
    expect(createReport).toMatch(/retention_expires_at\s+timestamptz NOT NULL/);
    expect(createReport).toMatch(/legal_hold\s+boolean NOT NULL DEFAULT false/);
  });

  it('§5b/ADR-0096: the retention lifecycle scan index excludes legal-hold rows', async () => {
    const statements = await runUp();
    expect(
      statements.some((s) =>
        /CREATE INDEX idx_compliance_report_retention_expires_unheld[\s\S]*WHERE NOT legal_hold/.test(s),
      ),
    ).toBe(true);
  });

  it('ADR-0093/0096: grants are least-privilege everywhere except compliance_report, which alone gets DELETE for the legal-hold-guarded lifecycle job', async () => {
    const statements = await runUp();
    for (const table of ALL_TABLES.filter((t) => t !== 'compliance_report')) {
      const grant = statements.find((s) =>
        new RegExp(`GRANT .* ON compliance\\.${table} TO agno_compliance_app`).test(s),
      );
      expect(grant).toBeDefined();
      expect(grant).toContain('SELECT');
      expect(grant).toContain('INSERT');
      expect(grant).toContain('UPDATE');
      expect(grant).not.toContain('DELETE');
    }
    const reportGrant = statements.find((s) =>
      /GRANT .* ON compliance\.compliance_report TO agno_compliance_app/.test(s),
    );
    expect(reportGrant).toContain('DELETE');
    expect(statements.some((s) => /GRANT CREATE ON SCHEMA compliance/.test(s))).toBe(false);
  });

  it('down() drops the whole schema (rollback plan)', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new InitialComplianceSchema1700003000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS compliance CASCADE/.test(s))).toBe(true);
  });
});
