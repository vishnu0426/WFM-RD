"""Named recurring rotation cycles ("Work Patterns" in the reference
console's own menu) - see `WorkPattern`'s own doc comment (`app/db/models.py`)
for what this is and isn't used for. Same plain-table/RLS/grant shape as
0006's shift_templates - small, user-managed reference data with real
UPDATE/DELETE.

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.work_patterns (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          days jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id)
        );
        """
    )
    op.execute("CREATE INDEX ix_work_patterns_tenant ON scheduling.work_patterns (tenant_id);")
    op.execute("ALTER TABLE scheduling.work_patterns ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.work_patterns FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling.work_patterns TO agno_scheduling_app;")


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.work_patterns;")
