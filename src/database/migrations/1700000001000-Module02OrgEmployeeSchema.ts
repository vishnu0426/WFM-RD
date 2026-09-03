import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 02 Phase 1 — full initial schema for Org Structure, Employee,
 * Skills, Calendar (§2), plus the SCD Type 2 history tables (§2.3) and the
 * `ErasureRequest` mechanism (§2.4) built in from day one rather than
 * retrofitted. See docs/module-02-phase-1-design-doc.md and
 * docs/adr/0008-0012 for the reasoning behind every non-obvious choice below
 * (ltree materialized path, HASH partitioning, trigger-written history,
 * reusing `core.policies` for `EmploymentPolicy`).
 *
 * Depends on Module 01's `core` schema (`core.tenants`, `core.users`) being
 * already applied. `core.fn_set_updated_at()` is reused directly on `org.*`
 * tables rather than duplicated - it is schema-agnostic (only touches
 * `NEW.updated_at`).
 */
export class Module02OrgEmployeeSchema1700000001000 implements MigrationInterface {
  name = 'Module02OrgEmployeeSchema1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // Schema + extension
    // ---------------------------------------------------------------------
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS org;`);
    // ltree is a PG13+ "trusted" extension - installable by agno_migrator
    // without superuser, as long as it has CREATE on the target schema
    // (public, granted to PUBLIC by default and never revoked here).
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;`);

    // ---------------------------------------------------------------------
    // Trigger functions (org_units: materialized-path maintenance + history)
    // ---------------------------------------------------------------------

    // ADR-0008. Single-label ltree segment per node, keyed by id (hyphens
    // aren't valid ltree label characters, hence the underscore swap).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_org_unit_set_path()
      RETURNS trigger AS $$
      DECLARE
        parent_path ltree;
      BEGIN
        IF NEW.parent_org_unit_id IS NULL THEN
          NEW.path := text2ltree(replace(NEW.id::text, '-', '_'));
        ELSE
          SELECT path INTO parent_path FROM org.org_units WHERE id = NEW.parent_org_unit_id;
          IF parent_path IS NULL THEN
            RAISE EXCEPTION 'parent_org_unit_id % has no path (missing, or not yet committed)', NEW.parent_org_unit_id;
          END IF;
          NEW.path := parent_path || text2ltree(replace(NEW.id::text, '-', '_'));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Recomputes this row's own path when parent_org_unit_id changes, and
    // rejects reparenting under self or a descendant (the parent's NEW path
    // would then be contained within this row's OLD path).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_org_unit_recompute_path_on_update()
      RETURNS trigger AS $$
      DECLARE
        parent_path ltree;
      BEGIN
        IF NEW.parent_org_unit_id IS DISTINCT FROM OLD.parent_org_unit_id THEN
          IF NEW.parent_org_unit_id IS NULL THEN
            NEW.path := text2ltree(replace(NEW.id::text, '-', '_'));
          ELSE
            SELECT path INTO parent_path FROM org.org_units WHERE id = NEW.parent_org_unit_id;
            IF parent_path IS NULL THEN
              RAISE EXCEPTION 'parent_org_unit_id % has no path', NEW.parent_org_unit_id;
            END IF;
            IF parent_path <@ OLD.path THEN
              RAISE EXCEPTION 'cannot reparent org unit % under its own descendant %', NEW.id, NEW.parent_org_unit_id;
            END IF;
            NEW.path := parent_path || text2ltree(replace(NEW.id::text, '-', '_'));
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Cascades a reparent's new path prefix onto every descendant in one
    // statement. Accepted trade-off (ADR-0008): reorgs are rare relative to
    // subtree reads, so this O(subtree size) write cost - occasionally
    // amplified by descendants' own AFTER-trigger firing a redundant,
    // idempotent no-op pass - is traded for O(1) live subtree reads via the
    // GiST index.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_org_unit_cascade_path()
      RETURNS trigger AS $$
      BEGIN
        UPDATE org.org_units
        SET path = NEW.path || subpath(path, nlevel(OLD.path))
        WHERE path <@ OLD.path AND id <> NEW.id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ADR-0009 (SCD Type 2). Versions on INSERT and on any change to a
    // tracked column; closes the prior open row via the column-scoped
    // UPDATE (valid_to) grant given to agno_app below.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_org_unit_history_track()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO org.org_unit_history (
            id, tenant_id, org_unit_id, valid_from, valid_to,
            parent_org_unit_id, type, name, timezone, country_code, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.created_at, NULL,
            NEW.parent_org_unit_id, NEW.type, NEW.name, NEW.timezone, NEW.country_code, NEW.status
          );
          RETURN NEW;
        END IF;

        IF NEW.parent_org_unit_id IS DISTINCT FROM OLD.parent_org_unit_id
           OR NEW.type IS DISTINCT FROM OLD.type
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.timezone IS DISTINCT FROM OLD.timezone
           OR NEW.country_code IS DISTINCT FROM OLD.country_code
           OR NEW.status IS DISTINCT FROM OLD.status THEN
          UPDATE org.org_unit_history SET valid_to = now() WHERE tenant_id = NEW.tenant_id AND org_unit_id = NEW.id AND valid_to IS NULL;
          INSERT INTO org.org_unit_history (
            id, tenant_id, org_unit_id, valid_from, valid_to,
            parent_org_unit_id, type, name, timezone, country_code, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, now(), NULL,
            NEW.parent_org_unit_id, NEW.type, NEW.name, NEW.timezone, NEW.country_code, NEW.status
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ADR-0009 (SCD Type 2), Employee side - versions on INSERT and on any
    // change to org_unit_id / manager_employee_id / status (§2.3).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_employee_history_track()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO org.employee_history (
            id, tenant_id, employee_id, valid_from, valid_to,
            org_unit_id, employee_number, employment_type, contract_hours_per_week, cost_center, manager_employee_id, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.created_at, NULL,
            NEW.org_unit_id, NEW.employee_number, NEW.employment_type, NEW.contract_hours_per_week, NEW.cost_center, NEW.manager_employee_id, NEW.status
          );
          RETURN NEW;
        END IF;

        IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id
           OR NEW.manager_employee_id IS DISTINCT FROM OLD.manager_employee_id
           OR NEW.status IS DISTINCT FROM OLD.status THEN
          UPDATE org.employee_history SET valid_to = now() WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.id AND valid_to IS NULL;
          INSERT INTO org.employee_history (
            id, tenant_id, employee_id, valid_from, valid_to,
            org_unit_id, employee_number, employment_type, contract_hours_per_week, cost_center, manager_employee_id, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, now(), NULL,
            NEW.org_unit_id, NEW.employee_number, NEW.employment_type, NEW.contract_hours_per_week, NEW.cost_center, NEW.manager_employee_id, NEW.status
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Derives EmployeeSkill.expiry_date from Skill.certification_validity_days
    // (§2.2 rule 3) - the application never sets expiry_date directly.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_employee_skill_set_expiry()
      RETURNS trigger AS $$
      DECLARE
        validity_days integer;
      BEGIN
        IF NEW.certified_date IS NULL THEN
          NEW.expiry_date := NULL;
          RETURN NEW;
        END IF;
        SELECT certification_validity_days INTO validity_days FROM org.skills WHERE id = NEW.skill_id;
        IF validity_days IS NULL THEN
          NEW.expiry_date := NULL;
        ELSE
          NEW.expiry_date := (NEW.certified_date + (validity_days || ' days')::interval)::date;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---------------------------------------------------------------------
    // org_units
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.org_units (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL REFERENCES core.tenants(id),
        parent_org_unit_id  uuid REFERENCES org.org_units(id),
        type                varchar(20) NOT NULL,
        name                varchar(255) NOT NULL,
        timezone            varchar(50) NOT NULL,
        country_code        varchar(2) NOT NULL,
        status              varchar(20) NOT NULL DEFAULT 'active',
        -- ADR-0008: materialized path, trigger-maintained only (never set by
        -- application code) - not mapped in the TypeORM entity.
        path                ltree,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT org_units_type_check CHECK (type IN ('business_unit','department','site','team')),
        CONSTRAINT org_units_status_check CHECK (status IN ('active','archived')),
        CONSTRAINT org_units_not_self_parent CHECK (parent_org_unit_id IS NULL OR parent_org_unit_id <> id),
        CONSTRAINT uq_org_units_tenant_id_id UNIQUE (tenant_id, id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_org_units_tenant_id_parent_org_unit_id ON org.org_units (tenant_id, parent_org_unit_id);`,
    );
    await queryRunner.query(`CREATE INDEX idx_org_units_tenant_id_status ON org.org_units (tenant_id, status);`);
    await queryRunner.query(`CREATE INDEX idx_org_units_path_gist ON org.org_units USING gist (path);`);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_units_updated_at BEFORE UPDATE ON org.org_units
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_units_set_path BEFORE INSERT ON org.org_units
      FOR EACH ROW EXECUTE FUNCTION org.fn_org_unit_set_path();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_units_recompute_path BEFORE UPDATE ON org.org_units
      FOR EACH ROW EXECUTE FUNCTION org.fn_org_unit_recompute_path_on_update();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_units_cascade_path AFTER UPDATE ON org.org_units
      FOR EACH ROW WHEN (OLD.path IS DISTINCT FROM NEW.path) EXECUTE FUNCTION org.fn_org_unit_cascade_path();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_units_history AFTER INSERT OR UPDATE ON org.org_units
      FOR EACH ROW EXECUTE FUNCTION org.fn_org_unit_history_track();
    `);

    // ---------------------------------------------------------------------
    // org_unit_history (ADR-0009, append-only)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.org_unit_history (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL REFERENCES core.tenants(id),
        org_unit_id         uuid NOT NULL REFERENCES org.org_units(id),
        valid_from          timestamptz NOT NULL,
        valid_to            timestamptz,
        parent_org_unit_id  uuid,
        type                varchar(20) NOT NULL,
        name                varchar(255) NOT NULL,
        timezone            varchar(50) NOT NULL,
        country_code        varchar(2) NOT NULL,
        status              varchar(20) NOT NULL,
        CONSTRAINT org_unit_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_org_unit_history_tenant_id_org_unit_id ON org.org_unit_history (tenant_id, org_unit_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_org_unit_history_one_open_version ON org.org_unit_history (tenant_id, org_unit_id) WHERE valid_to IS NULL;
    `);

    // ---------------------------------------------------------------------
    // skills
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.skills (
        id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                     uuid NOT NULL REFERENCES core.tenants(id),
        name                          varchar(255) NOT NULL,
        category                      varchar(100) NOT NULL,
        requires_certification        boolean NOT NULL DEFAULT false,
        certification_validity_days   integer,
        CONSTRAINT uq_skills_tenant_id_id UNIQUE (tenant_id, id),
        CONSTRAINT uq_skills_tenant_id_name UNIQUE (tenant_id, name),
        CONSTRAINT skills_validity_requires_cert CHECK (certification_validity_days IS NULL OR requires_certification)
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_skills_tenant_id_category ON org.skills (tenant_id, category);`);

    // ---------------------------------------------------------------------
    // employees (ADR-0010: PARTITION BY HASH (tenant_id), 8-way)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employees (
        tenant_id                 uuid NOT NULL REFERENCES core.tenants(id),
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        user_id                   uuid,
        org_unit_id               uuid NOT NULL,
        employee_number           varchar(50) NOT NULL,
        employment_type           varchar(20) NOT NULL,
        contract_hours_per_week   numeric(5,2) NOT NULL,
        hire_date                 date NOT NULL,
        termination_date          date,
        cost_center               varchar(100),
        manager_employee_id       uuid,
        status                    varchar(30) NOT NULL DEFAULT 'pending_onboarding',
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT employees_employment_type_check CHECK (employment_type IN ('full_time','part_time','contractor','seasonal')),
        CONSTRAINT employees_status_check CHECK (status IN ('active','on_leave','terminated','pending_onboarding')),
        CONSTRAINT employees_not_self_manager CHECK (manager_employee_id IS NULL OR manager_employee_id <> id),
        CONSTRAINT employees_termination_after_hire CHECK (termination_date IS NULL OR termination_date >= hire_date),
        CONSTRAINT uq_employees_tenant_id_employee_number UNIQUE (tenant_id, employee_number),
        -- Composite FKs against (tenant_id, id) unique constraints, not
        -- plain id FKs, so a mismatched tenant_id can never sneak past
        -- (org_unit_id belonging to a different tenant than the employee,
        -- etc.) - the FK itself enforces the tenant match, no trigger needed.
        CONSTRAINT fk_employees_tenant_org_unit FOREIGN KEY (tenant_id, org_unit_id) REFERENCES org.org_units (tenant_id, id),
        CONSTRAINT fk_employees_tenant_manager FOREIGN KEY (tenant_id, manager_employee_id) REFERENCES org.employees (tenant_id, id),
        -- §2.2 rule 2: user_id is nullable: this FK is skipped entirely
        -- (MATCH SIMPLE) when NULL, exactly the "not all employees have
        -- login access" case.
        CONSTRAINT fk_employees_tenant_user FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id)
      ) PARTITION BY HASH (tenant_id);
    `);
    await queryRunner.query(`
      DO $do$
      DECLARE
        i integer;
      BEGIN
        FOR i IN 0..7 LOOP
          EXECUTE format(
            'CREATE TABLE org.%I PARTITION OF org.employees FOR VALUES WITH (MODULUS 8, REMAINDER %s)',
            'employees_p' || i, i
          );
        END LOOP;
      END
      $do$;
    `);
    await queryRunner.query(
      `CREATE INDEX idx_employees_tenant_id_org_unit_id ON org.employees (tenant_id, org_unit_id);`,
    );
    await queryRunner.query(`CREATE INDEX idx_employees_tenant_id_status ON org.employees (tenant_id, status);`);
    await queryRunner.query(
      `CREATE INDEX idx_employees_tenant_id_manager_employee_id ON org.employees (tenant_id, manager_employee_id);`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON org.employees
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_employees_history AFTER INSERT OR UPDATE ON org.employees
      FOR EACH ROW EXECUTE FUNCTION org.fn_employee_history_track();
    `);

    // ---------------------------------------------------------------------
    // employee_history (ADR-0009 + ADR-0010, append-only, same partitioning)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_history (
        tenant_id                 uuid NOT NULL REFERENCES core.tenants(id),
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        employee_id               uuid NOT NULL,
        valid_from                timestamptz NOT NULL,
        valid_to                  timestamptz,
        org_unit_id               uuid NOT NULL,
        employee_number           varchar(50) NOT NULL,
        employment_type           varchar(20) NOT NULL,
        contract_hours_per_week   numeric(5,2) NOT NULL,
        cost_center               varchar(100),
        manager_employee_id       uuid,
        status                    varchar(30) NOT NULL,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT employee_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      ) PARTITION BY HASH (tenant_id);
    `);
    await queryRunner.query(`
      DO $do$
      DECLARE
        i integer;
      BEGIN
        FOR i IN 0..7 LOOP
          EXECUTE format(
            'CREATE TABLE org.%I PARTITION OF org.employee_history FOR VALUES WITH (MODULUS 8, REMAINDER %s)',
            'employee_history_p' || i, i
          );
        END LOOP;
      END
      $do$;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_employee_history_tenant_id_employee_id ON org.employee_history (tenant_id, employee_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employee_history_one_open_version ON org.employee_history (tenant_id, employee_id) WHERE valid_to IS NULL;
    `);

    // ---------------------------------------------------------------------
    // employee_skills (ADR-0010, same partitioning as employees for colocated joins)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_skills (
        tenant_id                    uuid NOT NULL REFERENCES core.tenants(id),
        employee_id                  uuid NOT NULL,
        skill_id                     uuid NOT NULL,
        proficiency_level            varchar(20) NOT NULL,
        certified_date                date,
        expiry_date                   date,
        decay_score                   numeric(4,3) NOT NULL DEFAULT 1,
        last_scheduled_on_skill_at    timestamptz,
        updated_at                    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, employee_id, skill_id),
        CONSTRAINT employee_skills_proficiency_check CHECK (proficiency_level IN ('trainee','proficient','expert')),
        CONSTRAINT employee_skills_decay_score_range CHECK (decay_score >= 0 AND decay_score <= 1),
        CONSTRAINT fk_employee_skills_tenant_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_employee_skills_tenant_skill FOREIGN KEY (tenant_id, skill_id)
          REFERENCES org.skills (tenant_id, id)
      ) PARTITION BY HASH (tenant_id);
    `);
    await queryRunner.query(`
      DO $do$
      DECLARE
        i integer;
      BEGIN
        FOR i IN 0..7 LOOP
          EXECUTE format(
            'CREATE TABLE org.%I PARTITION OF org.employee_skills FOR VALUES WITH (MODULUS 8, REMAINDER %s)',
            'employee_skills_p' || i, i
          );
        END LOOP;
      END
      $do$;
    `);
    await queryRunner.query(
      `CREATE INDEX idx_employee_skills_tenant_id_skill_id ON org.employee_skills (tenant_id, skill_id);`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_employee_skills_set_expiry BEFORE INSERT OR UPDATE OF certified_date ON org.employee_skills
      FOR EACH ROW EXECUTE FUNCTION org.fn_employee_skill_set_expiry();
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_employee_skills_updated_at BEFORE UPDATE ON org.employee_skills
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // working_time_calendars
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.working_time_calendars (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL REFERENCES core.tenants(id),
        org_unit_id                 uuid,
        country_code                varchar(2) NOT NULL,
        holiday_dates                jsonb NOT NULL DEFAULT '[]',
        standard_business_hours      jsonb NOT NULL DEFAULT '{}',
        created_at                   timestamptz NOT NULL DEFAULT now(),
        updated_at                   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_working_time_calendars_tenant_org_unit FOREIGN KEY (tenant_id, org_unit_id)
          REFERENCES org.org_units (tenant_id, id)
      );
    `);
    // At most one calendar per org unit, and separately at most one
    // tenant-wide default (org_unit_id IS NULL) - mirrors Policy's "one open
    // version" partial-index pattern (ADR-0006).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_working_time_calendars_tenant_org_unit ON org.working_time_calendars (tenant_id, org_unit_id) WHERE org_unit_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_working_time_calendars_tenant_default ON org.working_time_calendars (tenant_id) WHERE org_unit_id IS NULL;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_working_time_calendars_updated_at BEFORE UPDATE ON org.working_time_calendars
      FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
    `);

    // ---------------------------------------------------------------------
    // erasure_requests (§2.4 / ADR-0011 - mechanism only, no anonymization logic here)
    // ---------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.erasure_requests (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL REFERENCES core.tenants(id),
        employee_id     uuid NOT NULL,
        requested_by    uuid NOT NULL,
        requested_at    timestamptz NOT NULL DEFAULT now(),
        legal_basis     varchar(255) NOT NULL,
        status          varchar(20) NOT NULL DEFAULT 'pending',
        completed_at    timestamptz,
        CONSTRAINT erasure_requests_status_check CHECK (status IN ('pending','approved','completed','rejected')),
        CONSTRAINT erasure_requests_completed_consistency CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
        CONSTRAINT fk_erasure_requests_tenant_employee FOREIGN KEY (tenant_id, employee_id)
          REFERENCES org.employees (tenant_id, id),
        CONSTRAINT fk_erasure_requests_tenant_requested_by FOREIGN KEY (tenant_id, requested_by)
          REFERENCES core.users (tenant_id, id)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_erasure_requests_tenant_id_employee_id ON org.erasure_requests (tenant_id, employee_id);`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_erasure_requests_tenant_id_status ON org.erasure_requests (tenant_id, status);`,
    );

    // ---------------------------------------------------------------------
    // ADR-0012: extend Module 01's core.policies (additive only) instead of
    // a parallel EmploymentPolicy table.
    // ---------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE core.policies ADD COLUMN org_unit_id uuid;`);
    await queryRunner.query(
      `CREATE INDEX idx_policies_tenant_id_org_unit_id ON core.policies (tenant_id, org_unit_id);`,
    );
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN (
          'overtime_rule','break_rule','approval_chain','data_retention','rate_limit',
          'overtime_threshold','rest_period_minimum','max_consecutive_days','union_rule'
        )
      );
    `);

    // ---------------------------------------------------------------------
    // Row Level Security - identical tenant_isolation shape as core.* (RLS
    // on a partitioned parent applies to all its partitions automatically).
    // ---------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    const orgTenantScopedTables = [
      'org_units',
      'org_unit_history',
      'skills',
      'employees',
      'employee_history',
      'employee_skills',
      'working_time_calendars',
      'erasure_requests',
    ];
    for (const table of orgTenantScopedTables) {
      await queryRunner.query(`ALTER TABLE org.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON org.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // ---------------------------------------------------------------------
    // Grants - agno_app is the runtime role.
    // ---------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA org TO agno_app;`);
    // Archival is modeled via status = 'archived' (no DELETE).
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.org_units TO agno_app;`);
    // Append-only: INSERT always; UPDATE restricted to the valid_to column
    // (closing the prior open version), no DELETE at all - same posture as
    // core.audit_log (§2.2 rule 2 precedent).
    await queryRunner.query(`GRANT SELECT, INSERT ON org.org_unit_history TO agno_app;`);
    await queryRunner.query(`GRANT UPDATE (valid_to) ON org.org_unit_history TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.skills TO agno_app;`);
    // No DELETE on employees - status = 'terminated' is the soft-delete;
    // hard erasure goes through anonymization (§2.4), never row deletion.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.employees TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT ON org.employee_history TO agno_app;`);
    await queryRunner.query(`GRANT UPDATE (valid_to) ON org.employee_history TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.employee_skills TO agno_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON org.working_time_calendars TO agno_app;`);
    // No DELETE on erasure_requests - the request itself is a compliance record.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON org.erasure_requests TO agno_app;`);
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA org FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.policies DROP CONSTRAINT IF EXISTS policies_type_check;`);
    await queryRunner.query(`
      ALTER TABLE core.policies ADD CONSTRAINT policies_type_check CHECK (
        policy_type IN ('overtime_rule','break_rule','approval_chain','data_retention','rate_limit')
      );
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS core.idx_policies_tenant_id_org_unit_id;`);
    await queryRunner.query(`ALTER TABLE core.policies DROP COLUMN IF EXISTS org_unit_id;`);
    await queryRunner.query(`DROP SCHEMA IF EXISTS org CASCADE;`);
  }
}
