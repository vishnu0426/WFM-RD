import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP1: "Delete Data Source" is a
 * soft-delete (status transition), not a row DELETE - the initial migration
 * deliberately granted no DELETE on `integration_connector` to
 * `agno_integration_hub_app` ("No table here has a real delete mutation in
 * §3, so no DELETE grant anywhere"), and `field_mapping`/`sync_job`/
 * `field_authority_policy` (and this phase's new `reason_code`) all carry a
 * real FK to this table with no ON DELETE behavior defined, so a hard
 * DELETE would fail closed anyway once any sync/mapping history exists.
 * Adds `disabled` as a fourth reachable terminal status alongside the
 * original CHECK's four values.
 */
export class ConnectorDisabledStatus1700010300000 implements MigrationInterface {
  name = 'ConnectorDisabledStatus1700010300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      DROP CONSTRAINT integration_connector_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      ADD CONSTRAINT integration_connector_status_check
      CHECK (status IN ('active', 'paused', 'error', 'pending_setup', 'disabled'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE integration_hub.integration_connector SET status = 'paused' WHERE status = 'disabled';
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      DROP CONSTRAINT integration_connector_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.integration_connector
      ADD CONSTRAINT integration_connector_status_check
      CHECK (status IN ('active', 'paused', 'error', 'pending_setup'));
    `);
  }
}
