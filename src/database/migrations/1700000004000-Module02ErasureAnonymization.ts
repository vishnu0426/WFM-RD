import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 02 Phase 8 — GDPR erasure workflow (§2.4, §8). Only a single
 * grant change: `agno_app` gains `UPDATE (employee_number)` on
 * `org.employee_history`, additive to the `UPDATE (valid_to)` grant from
 * the Phase 1 migration. See docs/adr/0022-erasure-anonymization.md for why
 * this is a deliberate, narrow exception to `employee_history`'s
 * append-only posture (ADR-0009) rather than a new table or a widened
 * grant - `agno_app` still cannot touch `org_unit_id`/`status`/`valid_from`/
 * any other history column, only the one field GDPR erasure needs to
 * actually remove.
 *
 * No schema/table changes: `ErasureRequest`'s `status`/`completed_at`
 * columns and CHECK constraints already fully model the lifecycle
 * (ADR-0011, Phase 1) - Phase 8 is application logic against the existing
 * shape, not a new one.
 */
export class Module02ErasureAnonymization1700000004000 implements MigrationInterface {
  name = 'Module02ErasureAnonymization1700000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT UPDATE (employee_number) ON org.employee_history TO agno_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE (employee_number) ON org.employee_history FROM agno_app;`);
  }
}
