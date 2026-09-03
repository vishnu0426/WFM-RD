""""Campaigns" in the reference console's own menu - see `Campaign`'s own
doc comment (`app/db/models.py`) for what this is and isn't (no
dialer/telephony integration exists anywhere in this platform).

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-24
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE forecasting.campaigns (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(100) NOT NULL,
          description varchar(500),
          status varchar(16) NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'active', 'paused', 'completed')),
          start_date date,
          end_date date,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id),
          UNIQUE (tenant_id, id),
          CONSTRAINT ck_campaigns_date_range
            CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
        );
        """
    )
    op.execute("CREATE INDEX ix_campaigns_tenant ON forecasting.campaigns (tenant_id);")
    op.execute(
        "CREATE TRIGGER trg_campaigns_updated_at "
        "BEFORE UPDATE ON forecasting.campaigns "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    op.execute("ALTER TABLE forecasting.campaigns ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.campaigns FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON forecasting.campaigns TO agno_forecasting_app;")


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.campaigns;")
