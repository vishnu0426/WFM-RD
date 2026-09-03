import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Four new employee-admin sub-resources, added together since they share
 * one migration's worth of tenant_isolation/grant boilerplate: employee
 * groups (+ membership), per-employee/group work rules (+ assignment),
 * per-employee schedule preferences (one row per employee, upsert-only),
 * and an append-only employee interaction (manager/HR notes) log.
 *
 * None of these are hash-partitioned like `employees`/`employee_skills`
 * (ADR-0010) - all four are low-cardinality relative to the row-count
 * target that partitioning exists for (a tenant has orders of magnitude
 * fewer groups/work rules than employees, and even the notes log grows at
 * "a few rows per employee per year", not per-shift). Same unpartitioned
 * shape as `org.skills`/`org.working_time_calendars`.
 *
 * `work_rule_assignments.assignee_id` is a polymorphic reference
 * (`assignee_type` selects between `org.employees`/`org.employee_groups`)
 * - left without a DB-level FK (Postgres has no conditional FK), validated
 * at the application layer instead (`WorkRulesService.assign`), same
 * trade-off this schema already accepts elsewhere for polymorphic refs.
 */
export class EmployeeGroupsWorkRulesSchedulePreferencesInteractions1700000023000 implements MigrationInterface {
  name = 'EmployeeGroupsWorkRulesSchedulePreferencesInteractions1700000023000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------------
    // employee_groups + employee_group_members
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_groups (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL REFERENCES core.tenants(id),
        name         varchar(255) NOT NULL,
        description  text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_employee_groups_tenant_id_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_employee_groups_tenant_id_name UNIQUE (tenant_id, name)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE org.employee_group_members (
        tenant_id    uuid NOT NULL REFERENCES core.tenants(id),
        group_id     uuid NOT NULL,
        employee_id  uuid NOT NULL,
        added_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, group_id, employee_id),
        CONSTRAINT fk_employee_group_members_group FOREIGN KEY (tenant_id, group_id)
          REFERENCES org.employee_groups (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_employee_group_members_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id) ON DELETE CASCADE
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_employee_group_members_tenant_employee ON org.employee_group_members (tenant_id, employee_id);`,
    );

    // -----------------------------------------------------------------------
    // work_rules + work_rule_assignments
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.work_rules (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL REFERENCES core.tenants(id),
        name                   varchar(255) NOT NULL,
        description            text,
        max_consecutive_days   integer,
        min_rest_hours         numeric(5,2),
        max_weekly_hours       numeric(5,2),
        ot_eligible            boolean NOT NULL DEFAULT true,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_work_rules_tenant_id_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_work_rules_tenant_id_name UNIQUE (tenant_id, name),
        CONSTRAINT work_rules_max_consecutive_days_check CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
        CONSTRAINT work_rules_min_rest_hours_check CHECK (min_rest_hours IS NULL OR min_rest_hours >= 0),
        CONSTRAINT work_rules_max_weekly_hours_check CHECK (max_weekly_hours IS NULL OR max_weekly_hours > 0)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE org.work_rule_assignments (
        tenant_id      uuid NOT NULL REFERENCES core.tenants(id),
        work_rule_id   uuid NOT NULL,
        assignee_type  varchar(20) NOT NULL,
        assignee_id    uuid NOT NULL,
        assigned_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, work_rule_id, assignee_type, assignee_id),
        CONSTRAINT fk_work_rule_assignments_work_rule FOREIGN KEY (tenant_id, work_rule_id)
          REFERENCES org.work_rules (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT work_rule_assignments_assignee_type_check CHECK (assignee_type IN ('employee', 'group'))
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_work_rule_assignments_tenant_assignee ON org.work_rule_assignments (tenant_id, assignee_type, assignee_id);`,
    );

    // -----------------------------------------------------------------------
    // employee_schedule_preferences (one row per employee, upsert-only)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_schedule_preferences (
        tenant_id             uuid NOT NULL REFERENCES core.tenants(id),
        employee_id           uuid NOT NULL,
        preferred_shift_start time,
        preferred_shift_end   time,
        preferred_days_off    text[],
        max_weekly_hours      numeric(5,2),
        notes                 text,
        updated_at            timestamptz NOT NULL DEFAULT now(),
        updated_by            uuid,
        PRIMARY KEY (tenant_id, employee_id),
        CONSTRAINT fk_employee_schedule_preferences_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT employee_schedule_preferences_max_weekly_hours_check CHECK (max_weekly_hours IS NULL OR max_weekly_hours > 0)
      );
    `);

    // -----------------------------------------------------------------------
    // employee_interactions (append-only manager/HR notes log)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_interactions (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL REFERENCES core.tenants(id),
        employee_id        uuid NOT NULL,
        interaction_type   varchar(30) NOT NULL,
        body               text NOT NULL,
        created_by         uuid,
        created_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_employee_interactions_tenant_id_id UNIQUE (tenant_id, id),
        CONSTRAINT fk_employee_interactions_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT employee_interactions_type_check CHECK (
          interaction_type IN ('coaching', 'disciplinary', 'recognition', 'one_on_one', 'general_note')
        )
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_employee_interactions_tenant_employee ON org.employee_interactions (tenant_id, employee_id, created_at);`,
    );

    // -----------------------------------------------------------------------
    // Row Level Security - identical tenant_isolation shape as every other
    // org.* table (1700000001000).
    // -----------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const newTables = [
      'employee_groups',
      'employee_group_members',
      'work_rules',
      'work_rule_assignments',
      'employee_schedule_preferences',
      'employee_interactions',
    ];
    for (const table of newTables) {
      await queryRunner.query(`ALTER TABLE org.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON org.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_app is the runtime role.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.employee_groups TO agno_app;`);
    // Membership is add/remove only - no UPDATE column makes sense on a pure join row.
    await queryRunner.query(`GRANT SELECT, INSERT, DELETE ON org.employee_group_members TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.work_rules TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, DELETE ON org.work_rule_assignments TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.employee_schedule_preferences TO agno_app;`);
    // Append-only, same posture as core.audit_log / org.employee_skill_history
    // (§2.2 rule 2 precedent) - a note is never edited or removed, only added.
    await queryRunner.query(`GRANT SELECT, INSERT ON org.employee_interactions TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS org.employee_interactions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.employee_schedule_preferences;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.work_rule_assignments;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.work_rules;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.employee_group_members;`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.employee_groups;`);
  }
}
