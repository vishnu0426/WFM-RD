"""Campaign configuration fields named in the reference console's own menu
but never added when campaigns.py first shipped (0009): Time Zone, Week
Start Day, Day Boundary, Distributed Campaign, Scheduling Period. All
nullable/defaulted config metadata (no computed/derived signal involved,
same "real, not invented" posture `Campaign`'s own doc comment already
takes toward dialer telemetry) so every existing row stays valid unchanged.

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-31
"""

from __future__ import annotations

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE forecasting.campaigns
          ADD COLUMN time_zone varchar(64),
          ADD COLUMN week_start_day varchar(9)
            CHECK (week_start_day IN ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY')),
          ADD COLUMN day_boundary time,
          ADD COLUMN is_distributed_campaign boolean NOT NULL DEFAULT false,
          ADD COLUMN scheduling_period varchar(16)
            CHECK (scheduling_period IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE forecasting.campaigns
          DROP COLUMN time_zone,
          DROP COLUMN week_start_day,
          DROP COLUMN day_boundary,
          DROP COLUMN is_distributed_campaign,
          DROP COLUMN scheduling_period;
        """
    )
