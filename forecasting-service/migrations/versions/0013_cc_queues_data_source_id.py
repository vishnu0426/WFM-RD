"""Tenant Admin Integration Management, WP4: `cc_queues.data_source_id` -
a bare, nullable cross-service reference to an
integration-hub-service `integration_connector.id`. No real FK: that
table lives in a different service's own Postgres schema/role
(`integration_hub`, a separate database role per ADR-0136), the same
cross-service-reference-by-bare-id convention this platform already uses
elsewhere (e.g. `WorkRule.assigneeId`). Referential integrity against a
real connector is enforced at the application layer, by
integration-hub-service's own `DataSourceGroupsService`/Queue Mapping UI
(they resolve the connector first, then write/read this column via this
service's own real CRUD REST, not by trusting an unchecked id blindly).

Nullable, additive: every cc_queues row created before this migration
(and any created without going through the Integration Management UI)
stays valid with data_source_id left NULL.

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-03
"""

from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE forecasting.cc_queues ADD COLUMN data_source_id uuid;")
    op.execute(
        "CREATE INDEX ix_cc_queues_tenant_data_source "
        "ON forecasting.cc_queues (tenant_id, data_source_id);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX forecasting.ix_cc_queues_tenant_data_source;")
    op.execute("ALTER TABLE forecasting.cc_queues DROP COLUMN data_source_id;")
