import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-07, P1 (part 1 of 3): "No
 * backdated or future-dated change support anywhere in employee/org-unit
 * writes" - `org.fn_employee_history_track()`/`org.fn_org_unit_history_track()`
 * (`1700000001000`, refined by `1700000014000` for `cost_center`) always
 * version a change as of `now()`. A caller correcting a transfer that
 * should have taken effect last Monday, or scheduling a reorg that takes
 * effect next month, has no way to say so - every correction lands as
 * "effective right now," which is simply wrong for `getHierarchyAsOf`/
 * `findVersionAsOf`-style reconstruction of what was true on the date that
 * actually mattered.
 *
 * Fix: both trigger functions now resolve their effective timestamp via
 * `COALESCE(NULLIF(current_setting('app.effective_at', true), ''), now())`
 * - the same `set_config(..., true)`/`current_setting(..., true)` idiom
 * `app.current_tenant_id` already uses (a session-local GUC, transaction-
 * scoped via `SET LOCAL` semantics, `true` = missing_ok so an unset GUC
 * never errors). When the application never sets `app.effective_at` (every
 * existing caller, today), `current_setting(...)` returns NULL and this
 * resolves to exactly `now()` - byte-for-byte the pre-existing behavior,
 * with no data migration needed. `EmployeesRepository`/`OrgUnitsRepository`
 * opt in per-write by calling `set_config('app.effective_at', ...)` inside
 * the same transaction as the UPDATE, only when a caller supplies an
 * explicit `effectiveDate` (Part 2/3 of this fix, in application code).
 *
 * `CREATE OR REPLACE FUNCTION` on an existing SCD2 trigger is safe to apply
 * in-place, same precedent `1700000014000` already established for this
 * exact function.
 */
export class BackdatedEffectiveDateSupport1700000017000 implements MigrationInterface {
  name = 'BackdatedEffectiveDateSupport1700000017000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_org_unit_history_track()
      RETURNS trigger AS $$
      DECLARE
        effective_at timestamptz := COALESCE(NULLIF(current_setting('app.effective_at', true), '')::timestamptz, now());
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
          UPDATE org.org_unit_history SET valid_to = effective_at WHERE tenant_id = NEW.tenant_id AND org_unit_id = NEW.id AND valid_to IS NULL;
          INSERT INTO org.org_unit_history (
            id, tenant_id, org_unit_id, valid_from, valid_to,
            parent_org_unit_id, type, name, timezone, country_code, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, effective_at, NULL,
            NEW.parent_org_unit_id, NEW.type, NEW.name, NEW.timezone, NEW.country_code, NEW.status
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION org.fn_employee_history_track()
      RETURNS trigger AS $$
      DECLARE
        effective_at timestamptz := COALESCE(NULLIF(current_setting('app.effective_at', true), '')::timestamptz, now());
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
           OR NEW.status IS DISTINCT FROM OLD.status
           OR NEW.cost_center IS DISTINCT FROM OLD.cost_center THEN
          UPDATE org.employee_history SET valid_to = effective_at WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.id AND valid_to IS NULL;
          INSERT INTO org.employee_history (
            id, tenant_id, employee_id, valid_from, valid_to,
            org_unit_id, employee_number, employment_type, contract_hours_per_week, cost_center, manager_employee_id, status
          ) VALUES (
            gen_random_uuid(), NEW.tenant_id, NEW.id, effective_at, NULL,
            NEW.org_unit_id, NEW.employee_number, NEW.employment_type, NEW.contract_hours_per_week, NEW.cost_center, NEW.manager_employee_id, NEW.status
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the pre-fix (now()-hardcoded) function bodies exactly as
    // `1700000014000`/`1700000001000` left them.
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
           OR NEW.status IS DISTINCT FROM OLD.status
           OR NEW.cost_center IS DISTINCT FROM OLD.cost_center THEN
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
  }
}
