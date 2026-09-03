"""Module 03 Phase 5 - `service_level_targets`, the business-configuration
table Erlang C headcount conversion needs (target service level, target
answer time, max occupancy) that §2's own entity list never named. See
docs/adr/0023 for why this exists and why it defaults in application code
rather than requiring every tenant to configure it before their first
forecast.

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-06
"""

from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def _rls(table: str) -> None:
    """Same shape as migrations 0001/0002's `_rls` helpers - kept local to
    this file since Alembic migrations are independent, immutable-once-
    applied scripts."""
    op.execute(f"ALTER TABLE forecasting.{table} ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.{table} FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE forecasting.service_level_targets (
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          target_service_level numeric(4, 3) NOT NULL
            CHECK (target_service_level > 0 AND target_service_level <= 1),
          target_answer_time_seconds integer NOT NULL
            CHECK (target_answer_time_seconds > 0),
          max_occupancy numeric(4, 3) NOT NULL
            CHECK (max_occupancy > 0 AND max_occupancy <= 1),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, org_unit_id)
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_service_level_targets_updated_at "
        "BEFORE UPDATE ON forecasting.service_level_targets "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    _rls("service_level_targets")

    # Tenant-writable business configuration, not an admin-gated entitlement
    # like tenant_settings (ADR-0020) - full SELECT/INSERT/UPDATE.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON forecasting.service_level_targets TO agno_forecasting_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.service_level_targets;")
