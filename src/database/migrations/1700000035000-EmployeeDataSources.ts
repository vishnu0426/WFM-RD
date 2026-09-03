import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Management audit follow-up: `org.employees.agent_id`/`extension`/
 * `data_source` (migration `1700000027000`) modeled at most one ACD linkage
 * per employee. The reference screenshot this gap was found against shows
 * a real contact-center deployment assigns a *separate* Agent ID/Extension
 * per system an employee is provisioned on (AACC, CM, SR_DS, WFM_DS, ...) -
 * one row per system, not one overall. Replaces those three columns with
 * `org.employee_data_sources` (one row per (employee, data source)),
 * backfilling one row for every employee that already had a non-null
 * `data_source` before dropping the old columns, so no existing data is
 * lost. Uniqueness of Agent ID/Extension stays scoped per data source, same
 * reasoning `1700000031000-EmployeeAgentIdScopedUniqueness` already
 * established (two employees on different ACD systems can legitimately
 * share the same numeric agent id) - now naturally expressed as a plain
 * unique index on this table instead of a partial one on `org.employees`.
 */
export class EmployeeDataSources1700000035000 implements MigrationInterface {
  name = 'EmployeeDataSources1700000035000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE org.employee_data_sources (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES core.tenants(id),
        employee_id  uuid NOT NULL,
        data_source  varchar(100) NOT NULL,
        agent_id     varchar(100),
        extension    varchar(20),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_employee_data_sources_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id) ON DELETE CASCADE,
        -- One row per (employee, data source) - "add another AACC row" for
        -- the same employee makes no sense, it's an edit of the existing one.
        CONSTRAINT uq_employee_data_sources_employee_source UNIQUE (tenant_id, employee_id, data_source)
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employee_data_sources_agent_id
        ON org.employee_data_sources (tenant_id, data_source, agent_id)
        WHERE agent_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employee_data_sources_extension
        ON org.employee_data_sources (tenant_id, data_source, extension)
        WHERE extension IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_employee_data_sources_tenant_employee ON org.employee_data_sources (tenant_id, employee_id);
    `);

    // Backfill: one row per employee that already had a data source set.
    await queryRunner.query(`
      INSERT INTO org.employee_data_sources (id, tenant_id, employee_id, data_source, agent_id, extension)
      SELECT gen_random_uuid(), tenant_id, id, data_source, agent_id, extension
      FROM org.employees
      WHERE data_source IS NOT NULL;
    `);

    await queryRunner.query(`ALTER TABLE org.employee_data_sources ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON org.employee_data_sources FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.employee_data_sources TO agno_app;`);

    // Retire the old single-column model.
    await queryRunner.query(`DROP INDEX org.uq_employees_data_source_extension;`);
    await queryRunner.query(`DROP INDEX org.uq_employees_data_source_agent_id;`);
    await queryRunner.query(`
      ALTER TABLE org.employees
        DROP COLUMN agent_id,
        DROP COLUMN extension,
        DROP COLUMN data_source;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE org.employees
        ADD COLUMN agent_id    varchar(100),
        ADD COLUMN extension   varchar(20),
        ADD COLUMN data_source varchar(100);
    `);
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
    // Best-effort restore: an employee with more than one data source row
    // can only carry its single most-recently-updated one back onto the
    // retired single-column model - a lossy but unavoidable consequence of
    // reversing a genuine one-to-many redesign.
    await queryRunner.query(`
      UPDATE org.employees e
      SET agent_id = latest.agent_id, extension = latest.extension, data_source = latest.data_source
      FROM (
        SELECT DISTINCT ON (employee_id) employee_id, agent_id, extension, data_source
        FROM org.employee_data_sources
        ORDER BY employee_id, updated_at DESC
      ) latest
      WHERE e.id = latest.employee_id;
    `);
    await queryRunner.query(`DROP TABLE org.employee_data_sources;`);
  }
}
