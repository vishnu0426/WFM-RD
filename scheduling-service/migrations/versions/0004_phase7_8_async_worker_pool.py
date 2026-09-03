"""Module 04 Phase 7/8 - async worker pool (ADR-0060)

`schedule_jobs` gains what the worker pool needs: `job_kind` (which of
submit/relaxation_approval/reoptimize this row represents),
`request_payload` (the resupplied input a worker needs to actually run the
solve - gRPC pulls included, per §4.3's own "the worker pulls exactly what
it needs at solve time"), `target_schedule_id` (reoptimize's target),
`claimed_by`/`solving_started_at` (which worker has this claimed, and
since when - the reaper's own inputs), and `attempt_count` (caps requeue
churn on a job that reliably fails to solve).

`schedule_jobs`'s own RLS policy is widened to also allow
`app.is_platform_admin = true` through, mirroring Module 01/02's own
`core.tenants` policy shape exactly (verified against their real running
code in Phase 6) - scoped to this one table only; every other table this
module owns keeps its existing tenant-only policy unchanged. See
ADR-0060 Decision 3 for why this is safe and why it's the *only* table that
needs it (once a job is claimed, every other query for it runs
tenant-scoped as normal).

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-07
"""

from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

_JOB_KINDS = ("submit", "relaxation_approval", "reoptimize")
_TENANT_ID_EXPR = "current_setting('app.current_tenant_id', true)::uuid"
_PLATFORM_ADMIN_EXPR = "current_setting('app.is_platform_admin', true) = 'true'"


def upgrade() -> None:
    job_kind_check = "CHECK (job_kind IN (" + ", ".join(f"'{k}'" for k in _JOB_KINDS) + "))"
    op.execute(
        f"""
        ALTER TABLE scheduling.schedule_jobs
          ADD COLUMN job_kind varchar(24) NOT NULL DEFAULT 'submit' {job_kind_check},
          ADD COLUMN request_payload jsonb,
          ADD COLUMN target_schedule_id uuid,
          ADD COLUMN claimed_by varchar(255),
          ADD COLUMN solving_started_at timestamptz,
          ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
        """
    )
    # The worker's claim query (ADR-0060 Decision 2) scans across every
    # tenant's queued jobs - this index makes that scan cheap regardless of
    # RLS visibility.
    op.execute(
        "CREATE INDEX ix_schedule_jobs_status_requested_at ON scheduling.schedule_jobs "
        "(status, requested_at) WHERE status IN ('queued', 'solving');"
    )
    op.execute("DROP POLICY tenant_isolation ON scheduling.schedule_jobs;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.schedule_jobs FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR} OR {_PLATFORM_ADMIN_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR} OR {_PLATFORM_ADMIN_EXPR});
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY tenant_isolation ON scheduling.schedule_jobs;")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON scheduling.schedule_jobs FOR ALL
        USING (tenant_id = {_TENANT_ID_EXPR})
        WITH CHECK (tenant_id = {_TENANT_ID_EXPR});
        """
    )
    op.execute("DROP INDEX scheduling.ix_schedule_jobs_status_requested_at;")
    op.execute(
        """
        ALTER TABLE scheduling.schedule_jobs
          DROP COLUMN job_kind,
          DROP COLUMN request_payload,
          DROP COLUMN target_schedule_id,
          DROP COLUMN claimed_by,
          DROP COLUMN solving_started_at,
          DROP COLUMN attempt_count;
        """
    )
