import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 06 Phase 1 (§2, §5.1, §5.2, ADR-0073, ADR-0074): the full §2.1
 * entity set in one migration, per this phase's own scope ("Schema &
 * migrations. All entities in §2 including is_backdated/carryover fields
 * from day one - not retrofitted"). Reuses Module 01's
 * `app.current_tenant_id` RLS convention (ADR-0002) and the shared-database/
 * new-schema/new-role pattern (ADR-0017/0052/0066, restated for this schema
 * in ADR-0073) unchanged. Enum-typed columns are `varchar` + `CHECK`, not
 * native Postgres `ENUM` (ADR-0003).
 *
 * None of these tables are append-only in the `audit_log`/`adherence_event`
 * sense - `attendance_record` gets a clock-out UPDATE, `leave_balance` gets
 * balance-transition UPDATEs, `leave_request` gets a decision UPDATE,
 * `absence_pattern` gets an acknowledgement UPDATE - so `agno_attendance_leave_app`
 * is granted SELECT/INSERT/UPDATE on all five, never DELETE (cancellation/
 * rejection are status transitions, not row deletions - nothing in this
 * module's domain needs a hard delete).
 */
export class InitialAttendanceLeaveSchema1700000600000 implements MigrationInterface {
  name = 'InitialAttendanceLeaveSchema1700000600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS attendance_leave;`);

    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    // -----------------------------------------------------------------------
    // attendance_record (§2.1, §2.2 rule 3)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE attendance_leave.attendance_record (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        employee_id          uuid NOT NULL,
        clock_in_at          timestamptz NOT NULL,
        clock_out_at         timestamptz,
        source               varchar(20) NOT NULL,
        scheduled_shift_id   uuid,
        exception_type       varchar(30),
        exception_minutes    integer,
        PRIMARY KEY (id),
        CONSTRAINT attendance_record_source_check
          CHECK (source IN ('badge', 'biometric', 'manual', 'mobile_app')),
        CONSTRAINT attendance_record_exception_type_check
          CHECK (exception_type IS NULL OR exception_type IN ('late', 'early_leave', 'no_show', 'unscheduled_work')),
        CONSTRAINT attendance_record_clock_out_after_clock_in_check
          CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_attendance_record_tenant_employee_clock_in
      ON attendance_leave.attendance_record (tenant_id, employee_id, clock_in_at DESC);
    `);
    // §2.2 rule 3: the exact linkage Module 08's adherence scoring reads by.
    await queryRunner.query(`
      CREATE INDEX idx_attendance_record_scheduled_shift_id
      ON attendance_leave.attendance_record (scheduled_shift_id)
      WHERE scheduled_shift_id IS NOT NULL;
    `);

    // -----------------------------------------------------------------------
    // leave_type (§2.1, §5.2)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE attendance_leave.leave_type (
        id                       uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        name                     varchar(200) NOT NULL,
        accrual_policy_id        uuid NOT NULL,
        requires_approval        boolean NOT NULL DEFAULT true,
        requires_documentation   boolean NOT NULL DEFAULT false,
        max_consecutive_days     integer,
        carryover_rules          jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_leave_type_tenant ON attendance_leave.leave_type (tenant_id);
    `);

    // -----------------------------------------------------------------------
    // leave_balance (§2.1, §2.2 rule 1, §5.2, ADR-0074)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE attendance_leave.leave_balance (
        employee_id            uuid NOT NULL,
        leave_type_id          uuid NOT NULL,
        period_start            date NOT NULL,
        period_end               date NOT NULL,
        tenant_id               uuid NOT NULL,
        accrued_days            numeric(6,2) NOT NULL DEFAULT 0,
        used_days                numeric(6,2) NOT NULL DEFAULT 0,
        pending_days             numeric(6,2) NOT NULL DEFAULT 0,
        carryover_days_in       numeric(6,2) NOT NULL DEFAULT 0,
        carryover_expiry_date   date,
        PRIMARY KEY (employee_id, leave_type_id, period_start, period_end),
        CONSTRAINT leave_balance_period_check CHECK (period_end >= period_start),
        CONSTRAINT leave_balance_non_negative_check
          CHECK (accrued_days >= 0 AND used_days >= 0 AND pending_days >= 0 AND carryover_days_in >= 0)
      );
    `);
    // Phase 3's "does this employee have room for another leave request"
    // read, and the row-lock target ADR-0074 depends on, is already the PK
    // itself; this index backs the tenant-scoped listing access pattern
    // (`myLeaveBalances`).
    await queryRunner.query(`
      CREATE INDEX idx_leave_balance_tenant_employee ON attendance_leave.leave_balance (tenant_id, employee_id);
    `);

    // -----------------------------------------------------------------------
    // leave_request (§2.1, §2.2 rule 2, §5.1)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE attendance_leave.leave_request (
        id                        uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        employee_id               uuid NOT NULL,
        leave_type_id             uuid NOT NULL,
        date_range_start          date NOT NULL,
        date_range_end            date NOT NULL,
        status                    varchar(20) NOT NULL DEFAULT 'pending',
        approval_chain_id         uuid,
        requested_at              timestamptz NOT NULL DEFAULT now(),
        decided_at                timestamptz,
        decided_by                uuid,
        conflict_flags            jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_backdated              boolean NOT NULL DEFAULT false,
        backdated_reason          text,
        backdated_approved_by     uuid,
        PRIMARY KEY (id),
        CONSTRAINT leave_request_status_check
          CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        CONSTRAINT leave_request_date_range_check CHECK (date_range_end >= date_range_start),
        -- §5.1: a backdated request must carry its mandatory reason - a
        -- schema-level guarantee, not just an application-layer check
        -- (same posture as ADR-0054's "structurally impossible to violate"
        -- precedent), so a future write path can never silently skip it.
        CONSTRAINT leave_request_backdated_reason_required_check
          CHECK (NOT is_backdated OR backdated_reason IS NOT NULL)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_leave_request_tenant_employee_status
      ON attendance_leave.leave_request (tenant_id, employee_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_leave_request_tenant_status_requested_at
      ON attendance_leave.leave_request (tenant_id, status, requested_at DESC);
    `);
    // §5.1's compliance-monitoring metric ("backdated-entry frequency") and
    // the approval-chain workflow both filter on this combination.
    await queryRunner.query(`
      CREATE INDEX idx_leave_request_tenant_is_backdated
      ON attendance_leave.leave_request (tenant_id, is_backdated)
      WHERE is_backdated;
    `);

    // -----------------------------------------------------------------------
    // absence_pattern (§2.1, §2.2 rule 4)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE attendance_leave.absence_pattern (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        employee_id        uuid NOT NULL,
        pattern_type       varchar(40) NOT NULL,
        confidence_score   numeric(3,2) NOT NULL,
        detected_at        timestamptz NOT NULL DEFAULT now(),
        acknowledged_by    uuid,
        PRIMARY KEY (id),
        CONSTRAINT absence_pattern_type_check
          CHECK (pattern_type IN ('recurring_day_of_week', 'pre_post_holiday', 'frequency_threshold')),
        CONSTRAINT absence_pattern_confidence_score_check
          CHECK (confidence_score >= 0 AND confidence_score <= 1)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_absence_pattern_tenant_employee
      ON attendance_leave.absence_pattern (tenant_id, employee_id);
    `);
    // §2.2 rule 4: "is there anything actionable" is always filtered by
    // acknowledgement state first.
    await queryRunner.query(`
      CREATE INDEX idx_absence_pattern_tenant_unacknowledged
      ON attendance_leave.absence_pattern (tenant_id, detected_at DESC)
      WHERE acknowledged_by IS NULL;
    `);

    // -----------------------------------------------------------------------
    // Row Level Security (ADR-0002, unchanged convention)
    // -----------------------------------------------------------------------
    for (const table of ['attendance_record', 'leave_type', 'leave_balance', 'leave_request', 'absence_pattern']) {
      await queryRunner.query(`ALTER TABLE attendance_leave.${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON attendance_leave.${table} FOR ALL
        USING (tenant_id = ${tenantIdExpr})
        WITH CHECK (tenant_id = ${tenantIdExpr});
      `);
    }

    // -----------------------------------------------------------------------
    // Grants - agno_attendance_leave_app is the runtime role. No table here
    // is append-only (see this file's own doc comment); no DELETE grant on
    // any of them, and no CREATE on the schema at all.
    // -----------------------------------------------------------------------
    await queryRunner.query(`GRANT USAGE ON SCHEMA attendance_leave TO agno_attendance_leave_app;`);
    for (const table of ['attendance_record', 'leave_type', 'leave_balance', 'leave_request', 'absence_pattern']) {
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE ON attendance_leave.${table} TO agno_attendance_leave_app;`,
      );
    }
    await queryRunner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA attendance_leave FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SCHEMA IF EXISTS attendance_leave CASCADE;`);
  }
}
