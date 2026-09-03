import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP3: `reason_code`, `data_source_group`,
 * `data_source_group_queue` - net-new domains, no equivalent existed
 * anywhere in this platform (confirmed by research before writing this
 * migration). Same RLS/grant conventions as the initial schema.
 *
 * Unlike `integration_connector` (deliberately no DELETE grant - three
 * other tables carry a real FK to it, including this migration's own
 * `reason_code`), `reason_code` and `data_source_group` both get a real
 * DELETE grant: the spec's own UI explicitly calls for "Delete Reason
 * Code"/"Delete Group" actions, nothing else references a `reason_code`
 * row, and `data_source_group_queue` cascades on its parent group's
 * deletion (`ON DELETE CASCADE`) rather than requiring the application to
 * orchestrate a two-step delete.
 */
export class ReasonCodesAndDataSourceGroups1700010400000 implements MigrationInterface {
  name = 'ReasonCodesAndDataSourceGroups1700010400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // reason_code
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.reason_code (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        connector_id      uuid NOT NULL,
        external_id       varchar(200) NOT NULL,
        reason_code       varchar(200) NOT NULL,
        event_mode        varchar(50),
        event_reason      varchar(200),
        shift_operation   varchar(200) NOT NULL,
        origin            varchar(100),
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (connector_id, external_id),
        CONSTRAINT reason_code_connector_fk
          FOREIGN KEY (tenant_id, connector_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_reason_code_tenant_connector
      ON integration_hub.reason_code (tenant_id, connector_id);
    `);

    // -----------------------------------------------------------------------
    // data_source_group
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.data_source_group (
        id                     uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        data_source_id         uuid NOT NULL,
        name                   varchar(200) NOT NULL,
        description            varchar(2000),
        type                   varchar(100),
        avg_work_time_seconds  integer,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (data_source_id, name),
        CONSTRAINT data_source_group_data_source_fk
          FOREIGN KEY (tenant_id, data_source_id)
          REFERENCES integration_hub.integration_connector (tenant_id, id),
        CONSTRAINT data_source_group_avg_work_time_non_negative_check
          CHECK (avg_work_time_seconds IS NULL OR avg_work_time_seconds >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_data_source_group_tenant_data_source
      ON integration_hub.data_source_group (tenant_id, data_source_id);
    `);

    // -----------------------------------------------------------------------
    // data_source_group_queue (join; cc_queue_id is a bare cross-service
    // reference into forecasting-service's own schema, see the entity's own
    // doc comment - no FK constraint can span two services' schemas here)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE integration_hub.data_source_group_queue (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        group_id      uuid NOT NULL,
        cc_queue_id   uuid NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (group_id, cc_queue_id),
        CONSTRAINT data_source_group_queue_group_fk
          FOREIGN KEY (tenant_id, group_id)
          REFERENCES integration_hub.data_source_group (tenant_id, id)
          ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_data_source_group_queue_tenant_group
      ON integration_hub.data_source_group_queue (tenant_id, group_id);
    `);

    // -----------------------------------------------------------------------
    // Row Level Security - same convention as the initial schema.
    // -----------------------------------------------------------------------
    const tenantScopedTables = ['reason_code', 'data_source_group', 'data_source_group_queue'];
    for (const table of tenantScopedTables) {
      await queryRunner.query(`ALTER TABLE integration_hub.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON integration_hub.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - see this migration's own doc comment for why these two get a
    // real DELETE grant, unlike `integration_connector`.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration_hub.reason_code TO agno_integration_hub_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration_hub.data_source_group TO agno_integration_hub_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration_hub.data_source_group_queue TO agno_integration_hub_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.data_source_group_queue;`);
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.data_source_group;`);
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.reason_code;`);
  }
}
