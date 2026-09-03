"""Named, reusable coverage-requirement bundles ("Staffing Profiles" under
"Scenarios" in the reference console's own menu) - see `StaffingProfile`'s
own doc comment (`app/db/models.py`) for what this is and isn't used for.
Same plain-table/RLS/grant shape as 0006/0007 - small, user-managed
reference data with real UPDATE/DELETE.

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scheduling.staffing_profiles (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          entries jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id)
        );
        """
    )
    op.execute("CREATE INDEX ix_staffing_profiles_tenant ON scheduling.staffing_profiles (tenant_id);")
    op.execute("ALTER TABLE scheduling.staffing_profiles ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.staffing_profiles FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON scheduling.staffing_profiles TO agno_scheduling_app;")


def downgrade() -> None:
    op.execute("DROP TABLE scheduling.staffing_profiles;")
