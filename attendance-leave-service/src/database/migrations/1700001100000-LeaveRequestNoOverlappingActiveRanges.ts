import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise readiness audit (2026-08-18), GAP-09, P1: `LeaveConflictCheckService`
 * only ever checked a new request's date range against Module 04's *shift
 * schedule* (`scheduleClient.getShiftAssignments`) - it never checked
 * against the same employee's own *other* `leave_request` rows. Nothing
 * anywhere (not a race condition - a plain, always-reproducible gap) stopped
 * the same employee from having two overlapping `pending`/`approved` leave
 * requests for the same or overlapping dates, submitted sequentially, no
 * concurrency required.
 *
 * Fix: a real database constraint, not just an application-level check
 * (which would still be a TOCTOU race under concurrent submission) - a
 * PostgreSQL `EXCLUDE` constraint blocking two `pending`/`approved` rows
 * for the same `(tenant_id, employee_id)` from having overlapping
 * `[date_range_start, date_range_end]` ranges. `rejected`/`cancelled` rows
 * are excluded from the constraint (a WHERE-scoped exclusion, same idea as
 * `uq_marketplace_claim_one_live_per_post`'s partial-unique-index scoping
 * to "live" statuses only) - a rejected or cancelled request must not block
 * a later, legitimate request for the same dates.
 *
 * `btree_gist` is required: GiST natively indexes range-overlap (`&&`) but
 * needs this extension to also index plain equality (`=`) on the
 * `uuid` columns within the same GiST index, which is what lets the
 * constraint be scoped per-tenant-per-employee rather than colliding
 * across every employee in the table.
 */
export class LeaveRequestNoOverlappingActiveRanges1700001100000 implements MigrationInterface {
  name = 'LeaveRequestNoOverlappingActiveRanges1700001100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);

    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_request
      ADD CONSTRAINT leave_request_no_overlapping_active_ranges
      EXCLUDE USING gist (
        tenant_id WITH =,
        employee_id WITH =,
        daterange(date_range_start, date_range_end, '[]') WITH &&
      ) WHERE (status IN ('pending', 'approved'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_request DROP CONSTRAINT leave_request_no_overlapping_active_ranges;
    `);
  }
}
