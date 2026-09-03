"""Append-only backlog-age readings ("Backlog Age" in the reference
console's own menu) - see `BacklogSnapshot`'s own doc comment
(`app/db/models.py`) for what this is and isn't used for.

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
        CREATE TABLE forecasting.backlog_snapshots (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          template_id uuid,
          item_count integer NOT NULL CHECK (item_count >= 0),
          oldest_item_age_minutes integer NOT NULL CHECK (oldest_item_age_minutes >= 0),
          recorded_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id),
          CONSTRAINT fk_backlog_snapshots_tenant_template FOREIGN KEY (tenant_id, template_id)
            REFERENCES forecasting.backlog_age_templates (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_backlog_snapshots_tenant_org_unit_recorded "
        "ON forecasting.backlog_snapshots (tenant_id, org_unit_id, recorded_at DESC);"
    )
    op.execute("ALTER TABLE forecasting.backlog_snapshots ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.backlog_snapshots FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    # Append-only landing-zone data, same shape as `historical_actuals` -
    # no UPDATE/DELETE grant; a correction is a new, later snapshot.
    op.execute("GRANT SELECT, INSERT ON forecasting.backlog_snapshots TO agno_forecasting_app;")


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.backlog_snapshots;")
