import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the "Agent ID must be validated against Data Source, not globally
 * unique" gap: two employees on *different* ACD systems (e.g. Avaya vs.
 * Genesys) can legitimately share the same numeric agent id — uniqueness
 * only makes sense within one data source. Same for `extension`: a
 * telephony extension is only meaningful (and only needs to be unique)
 * within the ACD system that assigned it.
 *
 * Both are partial unique indexes scoped to `(tenant_id, data_source, ...)`
 * and only apply when both columns are actually set - an employee with no
 * ACD linkage yet (`data_source IS NULL`) imposes no constraint, matching
 * every other optional-field convention already used on this table.
 */
export class EmployeeAgentIdScopedUniqueness1700000031000 implements MigrationInterface {
  name = 'EmployeeAgentIdScopedUniqueness1700000031000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employees_data_source_agent_id
        ON org.employees (tenant_id, data_source, agent_id)
        WHERE data_source IS NOT NULL AND agent_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employees_data_source_extension
        ON org.employees (tenant_id, data_source, extension)
        WHERE data_source IS NOT NULL AND extension IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX org.uq_employees_data_source_extension;`);
    await queryRunner.query(`DROP INDEX org.uq_employees_data_source_agent_id;`);
  }
}
