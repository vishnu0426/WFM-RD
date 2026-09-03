import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 05 Phase 3 (§2.1/§3.4, ADR-0066): `intraday.adherence_event`
 * (append-only, `PARTITION BY RANGE (timestamp)` daily - a deliberate
 * departure from `core.audit_log`/`forecasting.forecast_data_points`'s
 * monthly precedent, see ADR-0066) plus the two pre-aggregated rollup
 * tables. First Postgres presence for this service - reuses Module 01's
 * `app.current_tenant_id` RLS convention (ADR-0002) and the shared-database/
 * new-schema/new-role pattern (ADR-0052) unchanged.
 *
 * `agno_intraday_app` (the runtime role) gets only SELECT/INSERT on
 * `adherence_event` (append-only, same posture as `core.audit_log`'s
 * REVOKE UPDATE/DELETE, §2.2 rule 2's shape applied here) and
 * SELECT/INSERT/UPDATE on the rollup tables - no CREATE on the `intraday`
 * schema at all. Partition creation/retention is DDL, and stays exclusively
 * on `agno_migrator` even at runtime (`AdherencePartitionSchedulerService`
 * holds its own narrowly-scoped migrator-credentialed connection, ADR-0066)
 * rather than widening this role's grants - the one point where this phase
 * deliberately does not just copy the "app role never does DDL" convention
 * verbatim, and says so explicitly rather than quietly bending it.
 */
export class InitialAdherenceSchema1700000200000 implements MigrationInterface {
  name = 'InitialAdherenceSchema1700000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS intraday;`);

    // -----------------------------------------------------------------------
    // adherence_event (ADR-0066: partitioned daily, append-only)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE intraday.adherence_event (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        employee_id         uuid NOT NULL,
        event_type          varchar(50) NOT NULL,
        from_activity       varchar(100),
        to_activity         varchar(100) NOT NULL,
        scheduled_activity  varchar(100),
        deviation_seconds   integer NOT NULL DEFAULT 0,
        "timestamp"         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT adherence_event_deviation_seconds_check CHECK (deviation_seconds >= 0),
        PRIMARY KEY (id, "timestamp")
      ) PARTITION BY RANGE ("timestamp");
    `);

    // tenant_id-first, matching this phase's own "most recent event for
    // employee X" lookup (AdherenceCalculatorConsumerService) and every
    // other tenant-scoped table's indexing convention in this platform.
    await queryRunner.query(`
      CREATE INDEX idx_adherence_event_tenant_employee_timestamp
      ON intraday.adherence_event (tenant_id, employee_id, "timestamp" DESC);
    `);
    // §3.4's explicit ask: BRIN, not another B-tree, for the append-mostly,
    // naturally-time-ordered write pattern - this repo's first BRIN index.
    // Created on the parent; PG11+ propagates matching indexes to every
    // existing and future partition automatically.
    await queryRunner.query(`
      CREATE INDEX idx_adherence_event_timestamp_brin
      ON intraday.adherence_event USING BRIN ("timestamp");
    `);

    // Local-dev/early-deploy partition bootstrap: today ± 3 days (7
    // partitions) - enough coverage until AdherencePartitionSchedulerService's
    // first daily tick runs. No DEFAULT partition (ADR-0005's same
    // fail-closed posture: an insert into an unprovisioned day fails
    // loudly rather than landing in a silent catch-all).
    await queryRunner.query(`
      DO $do$
      DECLARE
        start_day date := now()::date;
        i integer;
        part_name text;
        part_start date;
        part_end date;
      BEGIN
        FOR i IN -3..3 LOOP
          part_start := start_day + i;
          part_end := start_day + i + 1;
          part_name := 'adherence_event_' || to_char(part_start, 'YYYY_MM_DD');
          EXECUTE format(
            'CREATE TABLE intraday.%I PARTITION OF intraday.adherence_event FOR VALUES FROM (%L) TO (%L)',
            part_name, part_start, part_end
          );
        END LOOP;
      END
      $do$;
    `);

    // -----------------------------------------------------------------------
    // Rollup tables (§3.4, ADR-0066) - keyed by (tenant_id, employee_id),
    // not org_unit_id (no upstream payload in this platform carries it -
    // see ADR-0066's consequences section).
    // -----------------------------------------------------------------------
    for (const table of ['adherence_hourly_rollup', 'adherence_daily_rollup']) {
      await queryRunner.query(`
        CREATE TABLE intraday.${table} (
          tenant_id                uuid NOT NULL,
          employee_id              uuid NOT NULL,
          bucket_start             timestamptz NOT NULL,
          total_events             integer NOT NULL DEFAULT 0,
          non_adherent_events      integer NOT NULL DEFAULT 0,
          total_deviation_seconds  bigint NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, employee_id, bucket_start)
        );
      `);
      await queryRunner.query(`
        CREATE INDEX idx_${table}_tenant_bucket ON intraday.${table} (tenant_id, bucket_start DESC);
      `);
    }

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002, unchanged convention)
    // -----------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    for (const table of ['adherence_event', 'adherence_hourly_rollup', 'adherence_daily_rollup']) {
      await queryRunner.query(`ALTER TABLE intraday.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON intraday.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_intraday_app is the runtime role. adherence_event is
    // append-only at the grant level (§2.2 rule 2's same posture as
    // core.audit_log), same as this platform's convention everywhere else.
    // No CREATE on the schema - see this file's own doc comment.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA intraday TO agno_intraday_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT ON intraday.adherence_event TO agno_intraday_app;`);
    await queryRunner.query(`REVOKE UPDATE, DELETE ON intraday.adherence_event FROM agno_intraday_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.adherence_hourly_rollup TO agno_intraday_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON intraday.adherence_daily_rollup TO agno_intraday_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA intraday FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS intraday CASCADE;`);
  }
}
