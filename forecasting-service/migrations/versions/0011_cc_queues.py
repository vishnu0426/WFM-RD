"""`cc_queues` - the first-class contact-center queue entity mapping a raw
ACD-native queue id (e.g. `q_billing_us`) to a tenant/org unit. See
`CcQueue`'s own doc comment (`app/db/models.py`) for the full rationale and
why `QueueProfile`/`service_level_targets` only gain an *optional* `queue_id`
rather than being migrated onto this table outright.

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-26
"""

from __future__ import annotations

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE forecasting.cc_queues (
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          org_unit_id uuid NOT NULL,
          external_queue_id varchar(128) NOT NULL,
          acd_provider varchar(32),
          name varchar(100) NOT NULL,
          channel varchar(16) NOT NULL DEFAULT 'voice'
            CHECK (channel IN ('voice', 'chat', 'email', 'sms', 'social')),
          routing_config jsonb NOT NULL DEFAULT '{}'::jsonb,
          status varchar(16) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'inactive')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (id),
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, external_queue_id)
        );
        """
    )
    op.execute("CREATE INDEX ix_cc_queues_tenant_org_unit ON forecasting.cc_queues (tenant_id, org_unit_id);")
    op.execute(
        "CREATE TRIGGER trg_cc_queues_updated_at "
        "BEFORE UPDATE ON forecasting.cc_queues "
        "FOR EACH ROW EXECUTE FUNCTION forecasting.fn_set_updated_at();"
    )
    op.execute("ALTER TABLE forecasting.cc_queues ENABLE ROW LEVEL SECURITY;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON forecasting.cc_queues FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON forecasting.cc_queues TO agno_forecasting_app;")

    # Additive FK wiring - nullable, so every existing queue_profiles/
    # service_level_targets row (which predates cc_queues) stays valid with
    # queue_id left NULL until a tenant chooses to pin one.
    op.execute("ALTER TABLE forecasting.queue_profiles ADD COLUMN queue_id uuid REFERENCES forecasting.cc_queues (id) ON DELETE SET NULL;")
    op.execute("ALTER TABLE forecasting.service_level_targets ADD COLUMN queue_id uuid REFERENCES forecasting.cc_queues (id) ON DELETE SET NULL;")
    op.execute("CREATE INDEX ix_queue_profiles_queue_id ON forecasting.queue_profiles (queue_id);")
    op.execute("CREATE INDEX ix_service_level_targets_queue_id ON forecasting.service_level_targets (queue_id);")


def downgrade() -> None:
    op.execute("ALTER TABLE forecasting.service_level_targets DROP COLUMN queue_id;")
    op.execute("ALTER TABLE forecasting.queue_profiles DROP COLUMN queue_id;")
    op.execute("DROP TABLE forecasting.cc_queues;")
