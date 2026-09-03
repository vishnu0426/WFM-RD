import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-04, P0: `employee_history`
 * has always carried a `cost_center` column (`1700000001000`), but
 * `org.fn_employee_history_track()`'s change-detection condition only ever
 * compared `org_unit_id` / `manager_employee_id` / `status`. A cost-center-only
 * edit therefore fired the trigger, matched no branch, and left the
 * currently-open history row's `cost_center` silently stale relative to the
 * live `employees` row - any GL-allocation/payroll reconstruction of "what
 * cost center was this employee billed to on date Y" done after such an
 * edit returns a wrong answer with no signal anything is wrong.
 *
 * Fix: add `cost_center` to the change-detection condition so it versions
 * like every other tracked column. `CREATE OR REPLACE FUNCTION` on an
 * existing SCD2 trigger function is safe to apply in-place (matches the
 * pattern already used by `1700000002000`/`1700000003000` for this same
 * function's sibling triggers) - no data migration is required because this
 * only changes behavior for changes made from this point forward; it cannot
 * retroactively repair `cost_center` values already gone stale in existing
 * open history rows.
 */
export class EmployeeHistoryCostCenterTracking1700000014000 implements MigrationInterface {
  name = 'EmployeeHistoryCostCenterTracking1700000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores exactly the pre-fix (buggy) function body from
    // `1700000001000` - symmetric undo, not a schema removal.
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
  }
}
