"""Module 04 Phase 3 - `fairness_ledger` table (§3.3's cross-run read model)

§3.3: "the rolling-period window means this constraint spans schedule runs,
not just the current solve - the solver needs read access to *prior
published schedules'* shift distribution per employee as an input... Design
this data access explicitly (a `FairnessLedger` read model, refreshed off
`Schedule.published_at` events) rather than assuming the current solve has
enough context alone." This table is that read model. It is written once,
at publish time (`app/services/schedule_service.py`'s `publish_schedule`),
never at solve time - a solve that never gets published never contributes to
any employee's fairness history, matching "published" being the operative
event, not "solved."

Partitioned `RANGE` monthly on `shift_start`, same reasoning and same
bootstrap-only scope as `shift_assignments` (ADR-0053) - one row per employee
per published shift is exactly the same unbounded-by-employee-count growth
profile.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-06
"""

from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.fairness_ledger (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          employee_id uuid NOT NULL,
          schedule_id uuid NOT NULL,
          shift_start timestamptz NOT NULL,
          shift_end timestamptz NOT NULL,
          is_undesirable boolean NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id, shift_start),
          CONSTRAINT fk_fairness_ledger_tenant_schedule FOREIGN KEY (tenant_id, schedule_id)
            REFERENCES scheduling.schedules (tenant_id, id)
        ) PARTITION BY RANGE (shift_start);
        """
    )
    # Partial index - the only query this table serves is "count undesirable
    # shifts for these employees in this window" (fairness_service.py); rows
    # where is_undesirable is false are never filtered on it.
    op.execute(
        "CREATE INDEX ix_fairness_ledger_tenant_employee_shift ON scheduling.fairness_ledger "
        "(tenant_id, employee_id, shift_start) WHERE is_undesirable;"
    )
    op.execute(
        "CREATE INDEX ix_fairness_ledger_tenant_schedule ON scheduling.fairness_ledger "
        "(tenant_id, schedule_id);"
    )
    op.execute("ALTER TABLE scheduling.fairness_ledger ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.fairness_ledger FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    _create_monthly_partitions("fairness_ledger")
    op.execute("GRANT SELECT, INSERT ON scheduling.fairness_ledger TO agno_scheduling_app;")
    # `agno_scheduling_app` already has UPDATE on scheduling.schedules from
    # 0001's blanket per-table grant loop - publish_schedule needs no new
    # grant there.


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.fairness_ledger;")


def _create_monthly_partitions(table: str) -> None:
    """Same bootstrap-only scope as 0001's identically-named helper
    (current month +/- 1, no DEFAULT partition) - duplicated rather than
    imported across migration files, matching this codebase's "each
    migration is a self-contained, hand-written SQL script" convention
    (ADR-0016)."""
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
