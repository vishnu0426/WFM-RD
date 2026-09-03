import 'reflect-metadata';
import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * CI gate for §2.2 rule 1 ("tenant_id first column in every composite index,
 * no exceptions") and the RLS half of rule 1 ("enable Postgres Row Level
 * Security on every tenant-scoped table"). Both are introspected directly
 * from Postgres catalogs so this check holds even if a future migration
 * adds a table/index without updating any TypeScript entity - it is a
 * database-fact check, not a diff against application code.
 *
 * Requires a reachable Postgres with the Phase 1 migration already applied
 * (`npm run migration:run` first). Run via `npm run migration:lint`.
 */

// Schemas covered by this lint, with per-schema table lists - Module 02
// (`org`) added alongside Module 01 (`core`) rather than a parallel lint
// script, so both modules stay under the same CI gate.
const SCHEMAS = ['core', 'org'];

// Tables with a tenant_id column - must satisfy both RLS and the
// tenant_id-first composite index rule (§2.2 rule 1).
const TENANT_ID_COLUMN_TABLES = [
  'users',
  'roles',
  'role_permissions',
  'user_roles',
  'policies',
  'audit_log',
  'notification_preferences',
  'org_units',
  'org_unit_history',
  'skills',
  'employees',
  'employee_history',
  'employee_skills',
  'working_time_calendars',
  'erasure_requests',
  'decay_job_runs',
  'outbox_events',
  'bulk_import_jobs',
  'feature_flags',
  'oauth_clients',
  'user_credentials',
  'authorization_codes',
  'refresh_tokens',
  'tenant_identity_providers',
  'webauthn_credentials',
  'pending_audit_events',
  'webhook_subscriptions',
  'webhook_deliveries',
  'user_invites',
  'notification_delivery',
  'tenant_settings',
  'time_bank_entries',
];

// Every table that must have RLS enabled, including `tenants` (ADR-0007:
// self/BPO-children/platform-admin predicate, not a tenant_id column - so it
// only belongs in the RLS check, not the tenant_id-first index check).
// `permissions` and `signing_keys` are deliberately excluded from both - see
// each entity's own doc comment (global reference data, not tenant data).
const RLS_PROTECTED_TABLES = [...TENANT_ID_COLUMN_TABLES, 'tenants'];

// Structurally-necessary, individually-ADR'd exceptions to "tenant_id first
// column in every composite index" - not a general escape hatch, just the
// two cases where the rule can't hold by construction:
//   audit_log_pkey       - PARTITION BY RANGE (created_at) requires the
//                           partition key in the PK (ADR-0005).
//   role_permissions_pkey - the natural join-table key; tenant_id here is
//                           trigger-synced from a nullable parent column
//                           (ADR-0004), deliberately not part of the PK.
const KNOWN_NON_TENANT_FIRST_INDEXES = new Set(['audit_log_pkey', 'role_permissions_pkey']);

interface IndexColumnsRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  columns: string[];
}

interface RlsRow {
  schema_name: string;
  relname: string;
  relrowsecurity: boolean;
}

async function main(): Promise<void> {
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
    password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
    database: process.env.DB_DATABASE ?? 'agno_wfm',
  });
  await client.connect();

  const failures: string[] = [];

  try {
    // --- Check 1: RLS is enabled on every tenant-scoped table (parent
    // tables only - partitions inherit RLS/indexes automatically from their
    // partitioned parent and are excluded via the relname filter). ---
    const rls = await client.query<RlsRow>(
      `
      SELECT n.nspname AS schema_name, c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')
        AND c.relname = ANY($2::text[]);
    `,
      [SCHEMAS, RLS_PROTECTED_TABLES],
    );

    const rlsByTable = new Map(rls.rows.map((r) => [r.relname, r]));
    for (const table of RLS_PROTECTED_TABLES) {
      const row = rlsByTable.get(table);
      if (!row) {
        failures.push(
          `Table ${table} not found in any of [${SCHEMAS.join(', ')}] - has a migration renamed or dropped it?`,
        );
      } else if (!row.relrowsecurity) {
        failures.push(`Table ${row.schema_name}.${table} does not have Row Level Security enabled (§2.2 rule 1).`);
      }
    }

    // --- Check 2: every composite (multi-column) index on a tenant-scoped
    // table has tenant_id as its first column. ---
    const indexes = await client.query<IndexColumnsRow>(
      `
      SELECT
        ns.nspname AS schema_name,
        t.relname AS table_name,
        i.relname AS index_name,
        -- ::text cast: a.attname is Postgres's internal "name" type, and
        -- array_agg over it produces a name[] (OID 1003) result that node-pg
        -- doesn't parse into a JS array by default (unlike text[]) - cast so
        -- the driver hands back a real array, not a literal "{a,b}" string.
        array_agg(a.attname::text ORDER BY k.n) AS columns
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE ns.nspname = ANY($1::text[]) AND t.relname = ANY($2::text[])
      GROUP BY ns.nspname, t.relname, i.relname
      HAVING count(*) > 1;
    `,
      [SCHEMAS, TENANT_ID_COLUMN_TABLES],
    );

    for (const row of indexes.rows) {
      if (KNOWN_NON_TENANT_FIRST_INDEXES.has(row.index_name)) {
        continue;
      }
      if (row.columns[0] !== 'tenant_id') {
        failures.push(
          `Index ${row.index_name} on ${row.schema_name}.${row.table_name} does not have tenant_id as its first column ` +
            `(got: ${row.columns.join(', ')}) - violates §2.2 rule 1.`,
        );
      }
    }
  } finally {
    await client.end();
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('migration:lint FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `migration:lint OK - RLS enabled on: ${RLS_PROTECTED_TABLES.join(', ')}; ` +
      `tenant_id-first indexes verified on: ${TENANT_ID_COLUMN_TABLES.join(', ')}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('migration:lint crashed:', err);
  process.exitCode = 1;
});
