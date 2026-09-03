import { QueryRunner } from 'typeorm';
import { InitialIntegrationHubSchema1700010000000 } from '../../src/database/migrations/1700010000000-InitialIntegrationHubSchema';

/**
 * Captures every SQL string the migration's `up()` issues against a mock
 * `QueryRunner` and asserts the invariants §2/§2.2/§5a/§5b/§5c/ADR-0134/
 * ADR-0135/ADR-0136 depend on, so a future edit to this migration can't
 * silently drop RLS on one of the six tenant-scoped tables, widen a grant
 * past least-privilege, or reintroduce a conflict count on a streaming
 * SyncJob row. A real Postgres instance verification (RLS blocking a
 * cross-tenant read/write, every CHECK constraint actually rejecting bad
 * data, the composite FK rejecting a tenant/connector mismatch) was run
 * separately against a local instance - see the Phase 1 design doc's
 * verification section for that transcript; this spec is the fast,
 * CI-safe regression guard on top of it.
 */
describe('InitialIntegrationHubSchema1700010000000', () => {
  const TENANT_SCOPED_TABLES = [
    'integration_connector',
    'field_mapping',
    'sync_job',
    'webhook_subscription',
    'webhook_delivery',
    'field_authority_policy',
  ];
  const ALL_TABLES = [...TENANT_SCOPED_TABLES, 'provider_rate_limit_config'];

  async function runUp(): Promise<string[]> {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;

    const migration = new InitialIntegrationHubSchema1700010000000();
    await migration.up(queryRunner);
    return statements;
  }

  it('creates the integration_hub schema and all seven §2.1 tables', async () => {
    const statements = await runUp();
    expect(statements.some((s) => /CREATE SCHEMA IF NOT EXISTS integration_hub/.test(s))).toBe(true);
    for (const table of ALL_TABLES) {
      expect(statements.some((s) => new RegExp(`CREATE TABLE integration_hub\\.${table}`).test(s))).toBe(true);
    }
  });

  it('enables RLS with a tenant_isolation policy on every tenant-scoped table, and NOT on provider_rate_limit_config (ADR-0002, ADR-0136)', async () => {
    const statements = await runUp();
    for (const table of TENANT_SCOPED_TABLES) {
      expect(
        statements.some((s) => new RegExp(`ALTER TABLE integration_hub\\.${table} ENABLE ROW LEVEL SECURITY`).test(s)),
      ).toBe(true);
      expect(
        statements.some((s) => new RegExp(`CREATE POLICY tenant_isolation ON integration_hub\\.${table}`).test(s)),
      ).toBe(true);
    }
    expect(statements.some((s) => /ENABLE ROW LEVEL SECURITY/.test(s) && /provider_rate_limit_config/.test(s))).toBe(
      false,
    );
  });

  it('§2.2 rule 5/§2.1: a streaming SyncJob is structurally forbidden from carrying a records_conflicted value', async () => {
    const statements = await runUp();
    const createSyncJob = statements.find((s) => /CREATE TABLE integration_hub\.sync_job/.test(s));
    expect(createSyncJob).toMatch(
      /CONSTRAINT sync_job_streaming_has_no_conflicts_check\s+CHECK \(sync_type <> 'streaming' OR records_conflicted IS NULL\)/,
    );
  });

  it('ADR-0004-style denormalization: field_mapping/sync_job carry a composite FK tying tenant_id to their parent connector', async () => {
    const statements = await runUp();
    const createFieldMapping = statements.find((s) => /CREATE TABLE integration_hub\.field_mapping/.test(s));
    expect(createFieldMapping).toMatch(
      /FOREIGN KEY \(tenant_id, connector_id\)\s+REFERENCES integration_hub\.integration_connector \(tenant_id, id\)/,
    );
    const createSyncJob = statements.find((s) => /CREATE TABLE integration_hub\.sync_job/.test(s));
    expect(createSyncJob).toMatch(
      /FOREIGN KEY \(tenant_id, connector_id\)\s+REFERENCES integration_hub\.integration_connector \(tenant_id, id\)/,
    );
    const createWebhookDelivery = statements.find((s) => /CREATE TABLE integration_hub\.webhook_delivery/.test(s));
    expect(createWebhookDelivery).toMatch(
      /FOREIGN KEY \(tenant_id, webhook_subscription_id\)\s+REFERENCES integration_hub\.webhook_subscription \(tenant_id, id\)/,
    );
  });

  it('ADR-0136: provider_rate_limit_config is granted SELECT only, every other table gets SELECT/INSERT/UPDATE and never DELETE', async () => {
    const statements = await runUp();
    for (const table of TENANT_SCOPED_TABLES) {
      const grant = statements.find((s) =>
        new RegExp(`GRANT .* ON integration_hub\\.${table} TO agno_integration_hub_app`).test(s),
      );
      expect(grant).toBeDefined();
      expect(grant).toContain('SELECT');
      expect(grant).toContain('INSERT');
      expect(grant).toContain('UPDATE');
      expect(grant).not.toContain('DELETE');
    }
    const rateLimitGrant = statements.find((s) =>
      /GRANT .* ON integration_hub\.provider_rate_limit_config TO agno_integration_hub_app/.test(s),
    );
    expect(rateLimitGrant).toBeDefined();
    expect(rateLimitGrant).toContain('SELECT');
    expect(rateLimitGrant).not.toContain('INSERT');
    expect(rateLimitGrant).not.toContain('UPDATE');
    expect(rateLimitGrant).not.toContain('DELETE');
    expect(statements.some((s) => /GRANT CREATE ON SCHEMA integration_hub/.test(s))).toBe(false);
  });

  it('§2.1: provider is left an unconstrained varchar (no CHECK), unlike connector_type/status', async () => {
    const statements = await runUp();
    const createConnector = statements.find((s) => /CREATE TABLE integration_hub\.integration_connector/.test(s));
    expect(createConnector).toMatch(/provider\s+varchar\(100\) NOT NULL/);
    expect(createConnector).not.toMatch(/CHECK \(provider/);
    expect(createConnector).not.toContain('integration_connector_provider_check');
  });

  it('down() drops the whole schema (rollback plan)', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new InitialIntegrationHubSchema1700010000000();
    await migration.down(queryRunner);
    expect(statements.some((s) => /DROP SCHEMA IF EXISTS integration_hub CASCADE/.test(s))).toBe(true);
  });
});
