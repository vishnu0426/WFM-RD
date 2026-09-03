"""Module 03 Phase 8 - widens `tenant_settings`' grant from SELECT-only
(ADR-0020, Gap 2 - "no application write path in this phase") to also allow
INSERT/UPDATE, since `PUT /v1/forecasting/admin/tenant-settings`
(ADR-0026, Decision 5) is this service's first real write path for it -
platform-admin-gated at the application layer (`TenantContext.is_platform_admin`),
not by anything RLS-visible, since the row-level policy itself is unchanged
(still plain tenant isolation, no admin bypass). No new table - purely a
grant change on an existing one.

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-06
"""

from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("GRANT INSERT, UPDATE ON forecasting.tenant_settings TO agno_forecasting_app;")


def downgrade() -> None:
    op.execute("REVOKE INSERT, UPDATE ON forecasting.tenant_settings FROM agno_forecasting_app;")
