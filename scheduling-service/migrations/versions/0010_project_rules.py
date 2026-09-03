"""Reusable, named employment-policy library ("Project Rules" in the
reference console's own menu) - see `ProjectRule`'s own doc comment
(`app/db/models.py`) for what this is and isn't used for. Real CRUD, same
shape as 0006's `shift_templates`.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.project_rules (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          description varchar(500),
          max_consecutive_working_days integer NOT NULL,
          min_rest_hours_between_shifts numeric(4, 1) NOT NULL,
          min_shift_length_minutes integer NOT NULL,
          max_shift_length_minutes integer,
          allows_overtime boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id)
        );
        """
    )
    op.execute("CREATE INDEX ix_project_rules_tenant ON scheduling.project_rules (tenant_id);")
    op.execute("ALTER TABLE scheduling.project_rules ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.project_rules FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling.project_rules TO agno_scheduling_app;")


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.project_rules;")
