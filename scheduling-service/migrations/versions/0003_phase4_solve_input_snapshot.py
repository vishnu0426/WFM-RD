"""Module 04 Phase 4 - `schedule_jobs.solve_input_snapshot`

§5's relaxation-approval flow (`job_service.approve_relaxation`) needs to
re-solve the *same* roster/shifts/policy/leave data a job was originally
submitted with, potentially well after the original request completed. Per
ADR-0055 this data is request-supplied, not persisted, in Phase 2/3 - fine
when nothing needs it again. Phase 4 breaks that assumption specifically for
`infeasible` jobs: a human reviewing "would relaxing X help?" minutes or
hours later shouldn't have to reconstruct and resend the entire original
payload byte-for-byte to approve it. `solve_input_snapshot` is populated
only when a job resolves to `infeasible` (nullable, `NULL` for every other
status) - see docs/module-04-phase-4-design-doc.md for the full reasoning.

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


def upgrade() -> None:
    op.execute("ALTER TABLE scheduling.schedule_jobs ADD COLUMN solve_input_snapshot jsonb;")


def downgrade() -> None:
    op.execute("ALTER TABLE scheduling.schedule_jobs DROP COLUMN solve_input_snapshot;")
