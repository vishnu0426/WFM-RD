import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP6 (plan decision #7). Scorecards
 * Sources - six tables, confirmed to have zero equivalent anywhere in this
 * platform before this migration. Owned by analytics-reporting-service
 * (its actual domain: reporting/analytics measures), same
 * schema/role/RLS convention as the rest of this service
 * (`InitialAnalyticsSchema`).
 *
 * `scorecard_source_system.connector_id` is a bare cross-service reference
 * to integration-hub-service's `integration_connector.id` - same
 * no-real-FK convention this platform already uses for every other
 * cross-service reference (e.g. `WorkRule.assigneeId`,
 * `data_source_group_queue.cc_queue_id`), even though both schemas live in
 * the same physical Postgres instance: different schemas here are owned by
 * different application roles/services, treated as separate bounded
 * contexts, not just a physical-database boundary.
 *
 * `scorecard_source_mapping.target_metric` is tenant-authored free text,
 * not an FK onto `MetricDefinition` - no canonical, tenant-agnostic KPI
 * catalog exists to map onto (same reasoning as
 * `ReasonCode.shiftOperation` in integration-hub-service's own WP3).
 *
 * All six get a real DELETE grant, same as WP3's `reason_code`/
 * `data_source_group` - nothing else references these rows, and the spec
 * calls for real delete actions on every one of them.
 */
export class ScorecardSources1700011000000 implements MigrationInterface {
  name = 'ScorecardSources1700011000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_source_system (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        name           varchar(200) NOT NULL,
        provider       varchar(100) NOT NULL,
        connector_id   uuid,
        status         varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, name)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_source_measure (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        source_system_id   uuid NOT NULL,
        code               varchar(200) NOT NULL,
        name               varchar(200) NOT NULL,
        description        varchar(2000),
        unit               varchar(50),
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (source_system_id, code),
        CONSTRAINT scorecard_source_measure_system_fk
          FOREIGN KEY (tenant_id, source_system_id)
          REFERENCES analytics.scorecard_source_system (tenant_id, id)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_source_code (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        source_system_id   uuid NOT NULL,
        code               varchar(200) NOT NULL,
        description        varchar(2000),
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (source_system_id, code),
        CONSTRAINT scorecard_source_code_system_fk
          FOREIGN KEY (tenant_id, source_system_id)
          REFERENCES analytics.scorecard_source_system (tenant_id, id)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_source_mapping (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        source_measure_id   uuid NOT NULL,
        target_metric       varchar(200) NOT NULL,
        description         varchar(2000),
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (source_measure_id, target_metric),
        CONSTRAINT scorecard_source_mapping_measure_fk
          FOREIGN KEY (tenant_id, source_measure_id)
          REFERENCES analytics.scorecard_source_measure (tenant_id, id)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_dimension_type (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        name           varchar(200) NOT NULL,
        description    varchar(2000),
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, name)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE analytics.scorecard_dimension_member (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        dimension_type_id   uuid NOT NULL,
        code                varchar(200) NOT NULL,
        name                varchar(200) NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (dimension_type_id, code),
        CONSTRAINT scorecard_dimension_member_type_fk
          FOREIGN KEY (tenant_id, dimension_type_id)
          REFERENCES analytics.scorecard_dimension_type (tenant_id, id)
      );
    `);

    const tables = [
      'scorecard_source_system',
      'scorecard_source_measure',
      'scorecard_source_code',
      'scorecard_source_mapping',
      'scorecard_dimension_type',
      'scorecard_dimension_member',
    ];
    for (const table of tables) {
      await queryRunner.query(`
        CREATE INDEX idx_${table}_tenant ON analytics.${table} (tenant_id);
      `);
      await queryRunner.query(`ALTER TABLE analytics.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON analytics.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.${table} TO agno_analytics_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_dimension_member;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_dimension_type;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_source_mapping;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_source_code;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_source_measure;`);
    await queryRunner.query(`DROP TABLE IF EXISTS analytics.scorecard_source_system;`);
  }
}
