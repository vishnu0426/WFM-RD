"""Reusable shift-template library ("Shifts" in the reference console's own
menu) - a named, tenant-scoped time-of-day pair (e.g. "Morning", 09:00-17:00)
picked when composing a schedule's shift coverage instead of typing
start/end datetimes from scratch every time. Not partitioned or
append-only like the solve-output tables (fairness_ledger,
shift_assignments) - this is small, user-managed reference data with real
UPDATE/DELETE, closer in shape to `scheduling.schedule_conflicts`' plain
table than to anything solve-generated.

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.shift_templates (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          start_time time NOT NULL,
          end_time time NOT NULL,
          break_minutes integer NOT NULL DEFAULT 0,
          required_skill_id uuid,
          default_headcount integer NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id)
        );
        """
    )
    op.execute("CREATE INDEX ix_shift_templates_tenant ON scheduling.shift_templates (tenant_id);")
    op.execute("ALTER TABLE scheduling.shift_templates ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.shift_templates FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    # Real CRUD (not append-only), unlike every other grant in this
    # service — a template can be renamed or retired.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling.shift_templates TO agno_scheduling_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.shift_templates;")
