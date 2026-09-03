""""Queues" under Campaigns in the reference console's own menu - see
`CampaignQueue`'s own doc comment (`app/db/models.py`) for what this is.

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
        CREATE TABLE forecasting.campaign_queues (
          tenant_id uuid NOT NULL,
          campaign_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          added_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, campaign_id, org_unit_id),
          CONSTRAINT fk_campaign_queues_tenant_campaign FOREIGN KEY (tenant_id, campaign_id)
            REFERENCES forecasting.campaigns (tenant_id, id) ON DELETE CASCADE
        );
        """
    )
    op.execute("ALTER TABLE forecasting.campaign_queues ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.campaign_queues FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, DELETE ON forecasting.campaign_queues TO agno_forecasting_app;")


def downgrade() -> None:
    op.execute("DROP TABLE forecasting.campaign_queues;")
