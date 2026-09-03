import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-07, P1 (part 2 of 3): "skill
 * and calendar history are entirely absent (contrast: employment-policy
 * history is correctly built)" - `employee-skills.service.ts`'s
 * `updateForEmployee` and `working-time-calendars.service.ts`'s `upsert`
 * both do a plain `UPDATE` on the live row with nothing recording what the
 * value *was* before the change, unlike every other SCD Type 2 entity on
 * this platform (`org_unit`, `employee`, `core.policies`).
 *
 * Same trigger-based Type 2 shape as `org.fn_org_unit_history_track()`/
 * `org.fn_employee_history_track()` (`1700000001000`) - `AFTER INSERT OR
 * UPDATE`, versions on any change to a tracked column, `valid_from`/
 * `valid_to` resolved via `1700000017000`'s same `app.effective_at` GUC
 * (so a backdated skill re-certification or calendar correction versions
 * correctly too, not just employee/org-unit ones) - deliberately NOT the
 * application-layer lineage shape `core.policies` uses, since both of
 * these already have an established "live row + separate history table"
 * shape to extend, not a from-scratch design.
 *
 * `employee_skill_history` mirrors `employee_history`'s own partitioning
 * (`PARTITION BY HASH (tenant_id)`, 8 partitions) since `employee_skills`
 * itself is partitioned the same way (this platform's convention: a
 * per-employee-scoped table this large gets hash-partitioned).
 * `working_time_calendar_history` mirrors `org_unit_history`'s own
 * unpartitioned shape, matching `working_time_calendars`' own (a handful
 * of rows per tenant, one per org unit plus one tenant default).
 */
export class SkillAndCalendarHistorySchema1700000018000 implements MigrationInterface {
  name = 'SkillAndCalendarHistorySchema1700000018000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // clock_timestamp(), not now(): now() is transaction-scoped (returns the
    // transaction's *start* time, identical across every call within one
    // transaction) - a same-transaction INSERT immediately followed by an
    // UPDATE (this migration's own verification hit this for real) would
    // otherwise resolve both the new version's valid_from and the prior
    // version's valid_to to the exact same instant, violating
    // `..._valid_range`'s `valid_to > valid_from`. clock_timestamp() returns
    // the actual wall-clock time at each call, sidestepping this entirely -
    // strictly more correct for "effective as of" semantics regardless.
    const effectiveAtExpr = `COALESCE(NULLIF(current_setting('app.effective_at', true), '')::timestamptz, clock_timestamp())`;

    // -----------------------------------------------------------------------
    // employee_skill_history
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.employee_skill_history (
        tenant_id           uuid NOT NULL REFERENCES core.tenants(id),
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        employee_id         uuid NOT NULL,
        skill_id            uuid NOT NULL,
        valid_from          timestamptz NOT NULL,
        valid_to            timestamptz,
        proficiency_level   varchar(20) NOT NULL,
        certified_date      date,
        expiry_date         date,
        PRIMARY KEY (tenant_id, id),
        CONSTRAINT employee_skill_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      ) PARTITION BY HASH (tenant_id);
    `);
    await queryRunner.query(`
      DO $do$
      DECLARE
        i integer;
      BEGIN
        FOR i IN 0..7 LOOP
          EXECUTE format(
            'CREATE TABLE org.%I PARTITION OF org.employee_skill_history FOR VALUES WITH (MODULUS 8, REMAINDER %s)',
            'employee_skill_history_p' || i, i
          );
        END LOOP;
      END
      $do$;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_employee_skill_history_tenant_employee_skill ON org.employee_skill_history (tenant_id, employee_id, skill_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_employee_skill_history_one_open_version ON org.employee_skill_history (tenant_id, employee_id, skill_id) WHERE valid_to IS NULL;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_employee_skill_history_track()
      RETURNS trigger AS $$
      DECLARE
        effective_at timestamptz := ${effectiveAtExpr};
      BEGIN
        IF TG_OP = 'INSERT' THEN
          -- effective_at, not NEW.created_at: unlike org_units/employees,
          -- org.employee_skills has no created_at column of its own to
          -- anchor to - effective_at (which itself already honors a caller-
          -- supplied app.effective_at, e.g. "this certification was actually
          -- completed last month") is the only timestamp available here.
          INSERT INTO org.employee_skill_history (
            id, tenant_id, employee_id, skill_id, valid_from, valid_to,
            proficiency_level, certified_date, expiry_date
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.employee_id, NEW.skill_id, effective_at, NULL,
            NEW.proficiency_level, NEW.certified_date, NEW.expiry_date
          );
          RETURN NEW;
        END IF;

        IF NEW.proficiency_level IS DISTINCT FROM OLD.proficiency_level
           OR NEW.certified_date IS DISTINCT FROM OLD.certified_date
           OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
          UPDATE org.employee_skill_history SET valid_to = effective_at
            WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.employee_id AND skill_id = NEW.skill_id AND valid_to IS NULL;
          INSERT INTO org.employee_skill_history (
            id, tenant_id, employee_id, skill_id, valid_from, valid_to,
            proficiency_level, certified_date, expiry_date
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.employee_id, NEW.skill_id, effective_at, NULL,
            NEW.proficiency_level, NEW.certified_date, NEW.expiry_date
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    // AFTER, not BEFORE: must run after `trg_employee_skills_set_expiry`
    // (BEFORE INSERT OR UPDATE OF certified_date) has already derived the
    // final `expiry_date` - an AFTER trigger sees NEW as it will actually be
    // written, a BEFORE trigger firing first would capture the pre-derivation
    // (stale) expiry_date instead.
    await queryRunner.query(`
      CREATE TRIGGER trg_employee_skills_history AFTER INSERT OR UPDATE ON org.employee_skills
      FOR EACH ROW EXECUTE FUNCTION org.fn_employee_skill_history_track();
    `);

    // -----------------------------------------------------------------------
    // working_time_calendar_history
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE org.working_time_calendar_history (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL REFERENCES core.tenants(id),
        calendar_id                 uuid NOT NULL REFERENCES org.working_time_calendars(id),
        valid_from                  timestamptz NOT NULL,
        valid_to                    timestamptz,
        org_unit_id                 uuid,
        country_code                varchar(2) NOT NULL,
        timezone                    varchar(50) NOT NULL,
        holiday_dates                jsonb NOT NULL,
        standard_business_hours      jsonb NOT NULL,
        CONSTRAINT working_time_calendar_history_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_working_time_calendar_history_tenant_calendar ON org.working_time_calendar_history (tenant_id, calendar_id, valid_from);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_working_time_calendar_history_one_open_version ON org.working_time_calendar_history (tenant_id, calendar_id) WHERE valid_to IS NULL;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_working_time_calendar_history_track()
      RETURNS trigger AS $$
      DECLARE
        effective_at timestamptz := ${effectiveAtExpr};
      BEGIN
        IF TG_OP = 'INSERT' THEN
          -- NEW.created_at, not effective_at: same reasoning as
          -- org.fn_org_unit_history_track()/fn_employee_history_track()'s own
          -- INSERT branch - the first version opens at the row's actual
          -- creation time, not "whenever this trigger happened to fire."
          INSERT INTO org.working_time_calendar_history (
            id, tenant_id, calendar_id, valid_from, valid_to,
            org_unit_id, country_code, timezone, holiday_dates, standard_business_hours
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, NEW.created_at, NULL,
            NEW.org_unit_id, NEW.country_code, NEW.timezone, NEW.holiday_dates, NEW.standard_business_hours
          );
          RETURN NEW;
        END IF;

        IF NEW.country_code IS DISTINCT FROM OLD.country_code
           OR NEW.timezone IS DISTINCT FROM OLD.timezone
           OR NEW.holiday_dates IS DISTINCT FROM OLD.holiday_dates
           OR NEW.standard_business_hours IS DISTINCT FROM OLD.standard_business_hours THEN
          UPDATE org.working_time_calendar_history SET valid_to = effective_at
            WHERE tenant_id = NEW.tenant_id AND calendar_id = NEW.id AND valid_to IS NULL;
          INSERT INTO org.working_time_calendar_history (
            id, tenant_id, calendar_id, valid_from, valid_to,
            org_unit_id, country_code, timezone, holiday_dates, standard_business_hours
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, effective_at, NULL,
            NEW.org_unit_id, NEW.country_code, NEW.timezone, NEW.holiday_dates, NEW.standard_business_hours
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_working_time_calendars_history AFTER INSERT OR UPDATE ON org.working_time_calendars
      FOR EACH ROW EXECUTE FUNCTION org.fn_working_time_calendar_history_track();
    `);

    // -----------------------------------------------------------------------
    // RLS + grants - identical shape to org_unit_history/employee_history
    // (1700000001000): SELECT+INSERT, column-scoped UPDATE(valid_to) only,
    // no DELETE - append-only, same posture as core.audit_log.
    // -----------------------------------------------------------------------
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;
    for (const table of ['employee_skill_history', 'working_time_calendar_history']) {
      await queryRunner.query(`ALTER TABLE org.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON org.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
      await queryRunner.query(`GRANT SELECT, INSERT ON org.${table} TO agno_app;`);
      await queryRunner.query(`GRANT UPDATE (valid_to) ON org.${table} TO agno_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_working_time_calendars_history ON org.working_time_calendars;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS org.fn_working_time_calendar_history_track();`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.working_time_calendar_history;`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_employee_skills_history ON org.employee_skills;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS org.fn_employee_skill_history_track();`);
    await queryRunner.query(`DROP TABLE IF EXISTS org.employee_skill_history;`);
  }
}
