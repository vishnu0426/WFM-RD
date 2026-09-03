"""Reusable, named backlog-age threshold library ("Backlog Age Template" in
the reference console's own menu) - see `BacklogAgeTemplate`'s own doc
comment (`app/db/models.py`) for what this is and isn't used for. Real
CRUD, same shape as `scheduling.shift_templates`.

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
        CREATE TABLE forecasting.backlog_age_templates (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          description varchar(500),
          warning_threshold_minutes integer NOT NULL CHECK (warning_threshold_minutes > 0),
          critical_threshold_minutes integer NOT NULL
            CHECK (critical_threshold_minutes > warning_threshold_minutes),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id),
          -- Composite unique, not just (id) - lets `backlog_snapshots.template_id`
          -- carry a real (tenant_id, id) FK below, matching 0001's
          -- `fk_forecast_runs_tenant_model` convention.
          UNIQUE (tenant_id, id)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_backlog_age_templates_tenant ON forecasting.backlog_age_templates (tenant_id);"
    )
    op.execute(
        "CREATE TRIGGER trg_backlog_age_templates_updated_at "
        "BEFORE UPDATE ON forecasting.backlog_age_templates "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    op.execute("ALTER TABLE forecasting.backlog_age_templates ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.backlog_age_templates FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON forecasting.backlog_age_templates TO agno_forecasting_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.backlog_age_templates;")
