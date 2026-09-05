import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP5 follow-up: real "Database"
 * historical connectivity, per the spec's own §34 list of legitimate
 * historical sources ("Historical API, Vendor API, Database, CSV, SFTP,
 * Report Dump, Integration Package"). Adds `ConnectorType.DATABASE` and
 * `historical_record` - the landing table for rows a
 * `DatabaseHistoricalAdapter` chunk actually pulled from a tenant's own
 * external SQL database (real `pg` connection, real parameterized query,
 * real rows persisted - not a fabricated fetch).
 *
 * `historical_record.raw_data` is the "Raw Data" layer of the spec's own
 * Raw -> Normalized -> Canonical pipeline (§38/§20). Normalizing a row
 * into forecasting-service's canonical schema is NOT built by this
 * migration - that mapping is genuinely tenant/schema-specific (this
 * platform cannot guess what column in an arbitrary tenant database means
 * "call volume") and stays a disclosed BACKEND GAP, distinct from - and
 * much narrower than - "historical import doesn't work at all."
 */
export class DatabaseHistoricalSource1700010600000 implements MigrationInterface {
  name = 'DatabaseHistoricalSource1700010600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      DROP CONSTRAINT integration_connector_connector_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      ADD CONSTRAINT integration_connector_connector_type_check
      CHECK (connector_type IN ('hris', 'payroll', 'acd', 'crm', 'custom_webhook', 'database'));
    `);

    await queryRunner.query(`
      CREATE TABLE integration_hub.historical_record (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        sync_job_id    uuid NOT NULL,
        chunk_id       uuid NOT NULL,
        raw_data       jsonb NOT NULL,
        fetched_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT historical_record_sync_job_fk
          FOREIGN KEY (tenant_id, sync_job_id)
          REFERENCES integration_hub.sync_job (tenant_id, id),
        CONSTRAINT historical_record_chunk_fk
          FOREIGN KEY (chunk_id)
          REFERENCES integration_hub.historical_backfill_chunk (id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_historical_record_tenant_chunk
      ON integration_hub.historical_record (tenant_id, chunk_id);
    `);
    await queryRunner.query(`ALTER TABLE integration_hub.historical_record ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON integration_hub.historical_record FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`GRANT SELECT, INSERT ON integration_hub.historical_record TO agno_integration_hub_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.historical_record;`);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      DROP CONSTRAINT integration_connector_connector_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      ADD CONSTRAINT integration_connector_connector_type_check
      CHECK (connector_type IN ('hris', 'payroll', 'acd', 'crm', 'custom_webhook'));
    `);
  }
}
