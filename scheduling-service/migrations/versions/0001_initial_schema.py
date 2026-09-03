"""Module 04 Phase 1 - full initial `scheduling` schema

Full DDL for every §2 entity (`ScheduleJob`, `Schedule`, `ShiftAssignment`,
`ScheduleExplanation`, `ScheduleConflict`) plus the Phase-1-only
`idempotency_keys` table (§4.1's `Idempotency-Key` requirement). See
docs/module-04-phase-1-design-doc.md and docs/adr/0052-0054 for the reasoning
behind every non-obvious choice below (the new `scheduling` schema + role,
no cross-schema foreign keys, RANGE-by-time partitioning for
`shift_assignments`, the `locked` generated column).

Depends on Module 01's `core` schema already being applied (the
`agno_migrator` role and `agno_wfm` database already exist). Does NOT depend
on Module 02's `org` schema or Module 03's `forecasting` schema - per the
design doc, this service never reads those schemas' tables directly.

Revision ID: 0001
Revises:
Create Date: 2026-08-06
"""

from __future__ import annotations

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

# Postgres 15+ requires explicit CREATE on a non-owned database/schema even for
# a role with LOGIN - already granted to agno_migrator by Module 01/02/03's
# scripts/init-roles.sql, extended in this same PR for `scheduling` +
# `agno_scheduling_app` (see that file's diff).

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"

_JOB_STATUSES = ("queued", "solving", "completed", "failed", "infeasible")
_SCHEDULE_STATUSES = ("draft", "published", "archived")
_ASSIGNMENT_SOURCES = ("auto_generated", "manual_override", "swap", "bid")
_CONFLICT_TYPES = ("leave_overlap", "skill_gap", "overtime_breach", "double_booking")
_CONFLICT_STATUSES = ("open", "resolved", "acknowledged")


def _rls(table: str, *, tenant_col: str = "tenant_id") -> None:
    """Mirrors ADR-0002/ADR-0017 exactly: ENABLE (not FORCE) RLS, one
    `FOR ALL` policy comparing `tenant_col` to the same session GUC Module 01
    established. `agno_migrator` owns every table here (never
    `agno_scheduling_app`), so plain ENABLE already binds the runtime role
    unconditionally, same reasoning as Module 01/02/03."""
    op.execute(f"ALTER TABLE scheduling.{table} ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.{table} FOR ALL
        USING ({tenant_col} = {_TENANT_ID_EXPR})
        WITH CHECK ({tenant_col} = {_TENANT_ID_EXPR});
        """
    )


def upgrade() -> None:
    # -------------------------------------------------------------------
    # Schema
    # -------------------------------------------------------------------
    op.execute("CREATE SCHEMA IF NOT EXISTS scheduling;")

    # `agno_scheduling_app` has no USAGE on `core` (ADR-0052), so this schema
    # defines its own updated_at trigger function rather than reusing
    # `core.fn_set_updated_at()`, matching Module 03's `forecasting` schema.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION scheduling.fn_set_updated_at()
        RETURNS trigger AS $$
        BEGIN
          NEW.updated_at := now();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )

    job_status_check = "CHECK (status IN (" + ", ".join(f"'{s}'" for s in _JOB_STATUSES) + "))"
    schedule_status_check = (
        "CHECK (status IN (" + ", ".join(f"'{s}'" for s in _SCHEDULE_STATUSES) + "))"
    )

    # -------------------------------------------------------------------
    # schedule_jobs
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE scheduling.schedule_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          forecast_run_id uuid NOT NULL,
          date_range_start date NOT NULL,
          date_range_end date NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'queued' {job_status_check},
          constraint_config jsonb NOT NULL DEFAULT '{{}}'::jsonb,
          requested_by uuid,
          solve_duration_ms integer CHECK (solve_duration_ms IS NULL OR solve_duration_ms >= 0),
          objective_score numeric(14, 4),
          decomposition_plan jsonb,
          relaxations_applied jsonb,
          requested_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_schedule_jobs_tenant_id UNIQUE (tenant_id, id),
          CONSTRAINT ck_schedule_jobs_date_range CHECK (date_range_end >= date_range_start)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_schedule_jobs_tenant_org_unit ON scheduling.schedule_jobs "
        "(tenant_id, org_unit_id, date_range_start, date_range_end);"
    )
    op.execute(
        "CREATE INDEX ix_schedule_jobs_tenant_status ON scheduling.schedule_jobs "
        "(tenant_id, status);"
    )
    op.execute(
        "CREATE INDEX ix_schedule_jobs_tenant_forecast_run ON scheduling.schedule_jobs "
        "(tenant_id, forecast_run_id);"
    )
    op.execute(
        "CREATE TRIGGER trg_schedule_jobs_updated_at BEFORE UPDATE ON scheduling.schedule_jobs "
        "FOR EACH ROW EXECUTE FUNCTION scheduling.fn_set_updated_at();"
    )
    _rls("schedule_jobs")

    # -------------------------------------------------------------------
    # schedules
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE scheduling.schedules (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          schedule_job_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'draft' {schedule_status_check},
          published_at timestamptz,
          published_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_schedules_tenant_id UNIQUE (tenant_id, id),
          -- published_by is NOT required alongside published_at: this
          -- platform has no real JWT validation anywhere yet (ADR-0014's
          -- placeholder-header posture), so `TenantContext.actor_id` - and
          -- therefore published_by - is legitimately null today, matching
          -- ScheduleJob.requested_by's identical nullable-actor treatment.
          -- published_at alone is authoritative for "is this published."
          CONSTRAINT ck_schedules_published_fields CHECK (
            (status = 'published' AND published_at IS NOT NULL)
            OR (status <> 'published')
          ),
          CONSTRAINT fk_schedules_tenant_job FOREIGN KEY (tenant_id, schedule_job_id)
            REFERENCES scheduling.schedule_jobs (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_schedules_tenant_job ON scheduling.schedules (tenant_id, schedule_job_id);"
    )
    op.execute(
        "CREATE INDEX ix_schedules_tenant_org_unit_status ON scheduling.schedules "
        "(tenant_id, org_unit_id, status);"
    )
    op.execute(
        "CREATE TRIGGER trg_schedules_updated_at BEFORE UPDATE ON scheduling.schedules "
        "FOR EACH ROW EXECUTE FUNCTION scheduling.fn_set_updated_at();"
    )
    _rls("schedules")

    # -------------------------------------------------------------------
    # shift_assignments - PARTITION BY RANGE (shift_start), ADR-0053.
    # `locked` is GENERATED ALWAYS, ADR-0054.
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE scheduling.shift_assignments (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          schedule_id uuid NOT NULL,
          employee_id uuid NOT NULL,
          shift_start timestamptz NOT NULL,
          shift_end timestamptz NOT NULL,
          skill_id uuid,
          assignment_source varchar(16) NOT NULL DEFAULT 'auto_generated'
            CHECK (assignment_source IN ({", ".join(f"'{s}'" for s in _ASSIGNMENT_SOURCES)})),
          is_overtime boolean NOT NULL DEFAULT false,
          locked boolean GENERATED ALWAYS AS (assignment_source <> 'auto_generated') STORED,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id, shift_start),
          CONSTRAINT ck_shift_assignments_shift_range CHECK (shift_end > shift_start),
          CONSTRAINT fk_shift_assignments_tenant_schedule FOREIGN KEY (tenant_id, schedule_id)
            REFERENCES scheduling.schedules (tenant_id, id)
        ) PARTITION BY RANGE (shift_start);
        """
    )
    op.execute(
        "CREATE INDEX ix_shift_assignments_tenant_schedule ON scheduling.shift_assignments "
        "(tenant_id, schedule_id);"
    )
    op.execute(
        "CREATE INDEX ix_shift_assignments_tenant_employee_shift ON scheduling.shift_assignments "
        "(tenant_id, employee_id, shift_start);"
    )
    # Phase 5's pre-solve fixed/solvable partition step (§2.2 rule 1) filters
    # on this directly - ADR-0054.
    op.execute(
        "CREATE INDEX ix_shift_assignments_tenant_schedule_locked ON scheduling.shift_assignments "
        "(tenant_id, schedule_id, locked);"
    )
    _rls("shift_assignments")
    _create_monthly_partitions("shift_assignments")

    # -------------------------------------------------------------------
    # schedule_explanations
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE scheduling.schedule_explanations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          schedule_job_id uuid NOT NULL,
          summary_text text,
          top_constraints_json jsonb,
          trade_offs_json jsonb,
          generated_by_model_id uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_schedule_explanations_tenant_job UNIQUE (tenant_id, schedule_job_id),
          CONSTRAINT fk_schedule_explanations_tenant_job FOREIGN KEY (tenant_id, schedule_job_id)
            REFERENCES scheduling.schedule_jobs (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_schedule_explanations_updated_at "
        "BEFORE UPDATE ON scheduling.schedule_explanations "
        "FOR EACH ROW EXECUTE FUNCTION scheduling.fn_set_updated_at();"
    )
    _rls("schedule_explanations")

    # -------------------------------------------------------------------
    # schedule_conflicts
    # -------------------------------------------------------------------
    op.execute(
        f"""
        CREATE TABLE scheduling.schedule_conflicts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          schedule_id uuid NOT NULL,
          conflict_type varchar(24) NOT NULL
            CHECK (conflict_type IN ({", ".join(f"'{c}'" for c in _CONFLICT_TYPES)})),
          affected_employee_id uuid NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'open'
            CHECK (status IN ({", ".join(f"'{s}'" for s in _CONFLICT_STATUSES)})),
          suggested_resolution_json jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT fk_schedule_conflicts_tenant_schedule FOREIGN KEY (tenant_id, schedule_id)
            REFERENCES scheduling.schedules (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_schedule_conflicts_tenant_schedule_status ON scheduling.schedule_conflicts "
        "(tenant_id, schedule_id, status);"
    )
    op.execute(
        "CREATE INDEX ix_schedule_conflicts_tenant_employee ON scheduling.schedule_conflicts "
        "(tenant_id, affected_employee_id);"
    )
    op.execute(
        "CREATE TRIGGER trg_schedule_conflicts_updated_at "
        "BEFORE UPDATE ON scheduling.schedule_conflicts "
        "FOR EACH ROW EXECUTE FUNCTION scheduling.fn_set_updated_at();"
    )
    _rls("schedule_conflicts")

    # -------------------------------------------------------------------
    # idempotency_keys - §4.1's Idempotency-Key requirement, Phase 1 addition
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE scheduling.idempotency_keys (
          tenant_id uuid NOT NULL,
          idempotency_key varchar(255) NOT NULL,
          schedule_job_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, idempotency_key),
          CONSTRAINT fk_idempotency_keys_tenant_job FOREIGN KEY (tenant_id, schedule_job_id)
            REFERENCES scheduling.schedule_jobs (tenant_id, id)
        );
        """
    )
    _rls("idempotency_keys")

    # -------------------------------------------------------------------
    # Grants - table-level, explicit per table, matching scripts/init-roles.sql's
    # documented "exceptions are explicit and reviewable here" convention.
    # -------------------------------------------------------------------
    for table in (
        "schedule_jobs",
        "schedules",
        "shift_assignments",
        "schedule_explanations",
        "schedule_conflicts",
        "idempotency_keys",
    ):
        op.execute(f"GRANT SELECT, INSERT, UPDATE ON scheduling.{table} TO agno_scheduling_app;")
    op.execute(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA scheduling TO agno_scheduling_app;"
    )


def downgrade() -> None:
    op.execute("DROP SCHEMA scheduling CASCADE;")


def _create_monthly_partitions(table: str) -> None:
    """Bootstrap-only: current month +/- 1, same scope `audit_log` (ADR-0005)
    and `forecasting.forecast_data_points` (ADR-0018) both accept for Phase 1
    - production partition rotation is infra/process work (pg_partman or
    equivalent), not this migration's job (ADR-0053). No DEFAULT partition,
    deliberately: an insert into an unprovisioned month fails closed."""
    op.execute(
        f"""
        DO $$
        DECLARE
          month_start date;
          month_end date;
          partition_name text;
        BEGIN
          FOR offset_months IN -1..1 LOOP
            month_start := date_trunc('month', now() + (offset_months || ' months')::interval);
            month_end := month_start + interval '1 month';
            partition_name := '{table}_' || to_char(month_start, 'YYYY_MM');
            EXECUTE format(
              'CREATE TABLE scheduling.%I PARTITION OF scheduling.{table} FOR VALUES FROM (%L) TO (%L);',
              partition_name, month_start, month_end
            );
          END LOOP;
        END $$;
        """
    )
