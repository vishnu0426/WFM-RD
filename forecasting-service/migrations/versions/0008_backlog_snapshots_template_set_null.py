"""Fixes a real bug found during live verification: deleting a
`BacklogAgeTemplate` that still has `BacklogSnapshot` rows referencing it
raised a raw, unhandled `ForeignKeyViolationError` (500) instead of either
succeeding or failing with a friendly domain error. `template_id` is just
an informational "which thresholds were in effect" reference, recorded at
snapshot time - a template being retired later shouldn't permanently block
deleting it, so a deleted template's snapshots keep their reading and lose
only the (now-gone) threshold reference, same as `ON DELETE SET NULL`
already implies for `template_id` being nullable in the first place.

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


def upgrade() -> None:
    op.execute(
        "ALTER TABLE forecasting.backlog_snapshots "
        "DROP CONSTRAINT fk_backlog_snapshots_tenant_template;"
    )
    # Plain `ON DELETE SET NULL` would null every FK column, including
    # `tenant_id` - which is NOT NULL and would turn a template delete into
    # a *different* unhandled 500. The column-specific form (PG15+) nulls
    # only `template_id`, leaving `tenant_id` alone.
    op.execute(
        """
        ALTER TABLE forecasting.backlog_snapshots
          ADD CONSTRAINT fk_backlog_snapshots_tenant_template FOREIGN KEY (tenant_id, template_id)
            REFERENCES forecasting.backlog_age_templates (tenant_id, id) ON DELETE SET NULL (template_id);
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE forecasting.backlog_snapshots "
        "DROP CONSTRAINT fk_backlog_snapshots_tenant_template;"
    )
    op.execute(
        """
        ALTER TABLE forecasting.backlog_snapshots
          ADD CONSTRAINT fk_backlog_snapshots_tenant_template FOREIGN KEY (tenant_id, template_id)
            REFERENCES forecasting.backlog_age_templates (tenant_id, id);
        """
    )
