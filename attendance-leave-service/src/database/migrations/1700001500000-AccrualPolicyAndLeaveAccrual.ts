import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User Management audit GAP-02: closes the previously-disclosed gap that no
 * recurring accrual mechanism exists — `LeaveType.accrual_policy_id` was a
 * plain uuid pointing at nothing resolvable (its own doc comment says it
 * was meant to reference Module 02's `EmploymentPolicy` via gRPC, but that
 * link was never actually built: `EmploymentPolicyType` has no
 * accrual-related value at all, and this service has no gRPC client to
 * resolve one either way). Rather than build that larger cross-service
 * integration, this adds a real, self-contained `accrual_policy` catalog in
 * this same schema — `accrual_policy_id` still has no DB-level FK to it
 * (same "no FK, service-layer validation" convention `WorkRuleAssignment`
 * already uses in the root service for its own polymorphic reference), so
 * existing `LeaveType` rows with a stray random uuid keep working
 * unchanged; only new writes are validated against this catalog going
 * forward (`AccrualPolicyService`/`LeaveTypeService`).
 *
 * `leave_balance.last_accrued_at` is the new accrual job's own idempotency
 * marker, same role `carryover_applied` already plays for the rollover job.
 */
export class AccrualPolicyAndLeaveAccrual1700001500000 implements MigrationInterface {
  name = 'AccrualPolicyAndLeaveAccrual1700001500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      CREATE TABLE attendance_leave.accrual_policy (
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        name                      varchar(200) NOT NULL,
        accrual_rate_per_period   numeric(6,2) NOT NULL,
        accrual_frequency         varchar(20) NOT NULL,
        max_balance_cap           numeric(6,2),
        status                    varchar(20) NOT NULL DEFAULT 'active',
        created_at                timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        CONSTRAINT accrual_policy_frequency_check
          CHECK (accrual_frequency IN ('weekly', 'biweekly', 'monthly', 'annually')),
        CONSTRAINT accrual_policy_status_check CHECK (status IN ('active', 'disabled')),
        CONSTRAINT accrual_policy_rate_positive_check CHECK (accrual_rate_per_period >= 0)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_accrual_policy_tenant ON attendance_leave.accrual_policy (tenant_id);
    `);

    await queryRunner.query(`
      ALTER TABLE attendance_leave.leave_balance
        ADD COLUMN last_accrued_at date;
    `);

    await queryRunner.query(`ALTER TABLE attendance_leave.accrual_policy ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON attendance_leave.accrual_policy FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_leave.accrual_policy TO agno_attendance_leave_app;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE attendance_leave.leave_balance DROP COLUMN last_accrued_at;`);
    await queryRunner.query(`DROP TABLE attendance_leave.accrual_policy;`);
  }
}
