"""Allocations - splits an org unit's required headcount across skills.

One row per (tenant, org unit, skill); the full set for an org unit is
expected to sum to 100% (validated in the API layer, `allocations.py`, the
same way `DateRange`/rejection-reason invariants are validated at the
Pydantic boundary rather than the DB).

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE forecasting.headcount_allocations (
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          skill_id uuid NOT NULL,
          allocation_percentage numeric(5, 2) NOT NULL
            CHECK (allocation_percentage > 0 AND allocation_percentage <= 100),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, org_unit_id, skill_id)
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_headcount_allocations_updated_at "
        "BEFORE UPDATE ON forecasting.headcount_allocations "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    op.execute("ALTER TABLE forecasting.headcount_allocations ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.headcount_allocations FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    # Tenant-writable business configuration, matching service_level_targets
    # (0003) - full SELECT/INSERT/UPDATE/DELETE since a save replaces the
    # full set for an org unit (delete-then-recreate in one transaction).
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON forecasting.headcount_allocations TO agno_forecasting_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.headcount_allocations;")
