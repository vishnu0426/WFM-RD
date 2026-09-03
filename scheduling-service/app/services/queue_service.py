"""ADR-0060's queue mechanics: the `SELECT ... FOR UPDATE SKIP LOCKED` claim
and the reaper sweep, factored out of `app/worker.py` so they're testable
without spinning up the actual polling loop. Both run under
`platform_admin_context()` - the only two operations in this whole service
that ever bypass per-tenant RLS, and only against `schedule_jobs`
(migration 0004 widened that one table's policy specifically for this).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.tenant_context import TenantContext, platform_admin_context
from app.db.session import tenant_scoped_session

_CLAIM_STMT = text(
    """
    UPDATE scheduling.schedule_jobs
    SET status = 'solving', claimed_by = :worker_id, solving_started_at = now(), updated_at = now()
    WHERE id = (
        SELECT id FROM scheduling.schedule_jobs
        WHERE status = 'queued'
          AND (job_kind != 'submit' OR request_payload IS NOT NULL)
        ORDER BY requested_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id, tenant_id
    """
)

_REAP_REQUEUE_STMT = text(
    """
    UPDATE scheduling.schedule_jobs
    SET status = 'queued', claimed_by = NULL, solving_started_at = NULL,
        attempt_count = attempt_count + 1, updated_at = now()
    WHERE status = 'solving'
      AND solving_started_at < now() - make_interval(secs => :threshold_seconds)
      AND attempt_count < :max_attempts
    RETURNING id
    """
)

_REAP_FAIL_STMT = text(
    """
    UPDATE scheduling.schedule_jobs
    SET status = 'failed', completed_at = now(), updated_at = now(),
        relaxations_applied = COALESCE(relaxations_applied, '{}'::jsonb) || CAST(:failure_reason AS jsonb)
    WHERE status = 'solving'
      AND solving_started_at < now() - make_interval(secs => :threshold_seconds)
      AND attempt_count >= :max_attempts
    RETURNING id, tenant_id, org_unit_id
    """
)


@dataclass(frozen=True)
class ClaimedJob:
    job_id: uuid.UUID
    tenant_id: uuid.UUID


@dataclass(frozen=True)
class ReapedFailure:
    job_id: uuid.UUID
    tenant_id: uuid.UUID
    org_unit_id: uuid.UUID


async def claim_next_job(
    session_factory: async_sessionmaker[AsyncSession], *, worker_id: str
) -> ClaimedJob | None:
    """Claims the oldest queued job across every tenant. Returns only the
    id/tenant - the caller opens a normal `tenant_scoped_session` for that
    tenant to actually fetch and process it (ADR-0060 Decision 3): the
    platform-admin bypass exists only for this one query's own transaction,
    never longer."""
    async with tenant_scoped_session(
        platform_admin_context(), session_factory=session_factory
    ) as admin_session:
        row = (await admin_session.execute(_CLAIM_STMT, {"worker_id": worker_id})).first()
    if row is None:
        return None
    return ClaimedJob(job_id=row.id, tenant_id=row.tenant_id)


async def reap_stuck_jobs(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    threshold_seconds: int,
    max_attempts: int,
) -> list[ReapedFailure]:
    """§7.2's reaper: a job stuck in `solving` past `threshold_seconds`
    (a worker that died mid-solve, not a clean shutdown - graceful draining
    never leaves a row in `solving` past its own completion) is requeued,
    `attempt_count` incremented; a job that's already exhausted
    `max_attempts` is marked `failed` instead of requeued forever (a
    "poison" job - e.g. a genuinely un-decomposable oversized input that
    reliably times out). Returns the jobs that were marked `failed` so the
    caller can publish their completion events (`schedule_jobs` itself
    already reflects both outcomes; nothing else needs updating for the
    requeued case, which isn't a terminal state)."""
    async with tenant_scoped_session(
        platform_admin_context(), session_factory=session_factory
    ) as admin_session:
        await admin_session.execute(
            _REAP_REQUEUE_STMT, {"threshold_seconds": threshold_seconds, "max_attempts": max_attempts}
        )
        failure_reason = json.dumps(
            {
                "failureReason": {
                    "code": "REAPER_MAX_ATTEMPTS_EXCEEDED",
                    "message": (
                        f"stuck in 'solving' past the {threshold_seconds}s reaper threshold "
                        f"{max_attempts} times in a row"
                    ),
                    "details": {},
                }
            }
        )
        rows = (
            await admin_session.execute(
                _REAP_FAIL_STMT,
                {
                    "threshold_seconds": threshold_seconds,
                    "max_attempts": max_attempts,
                    "failure_reason": failure_reason,
                },
            )
        ).all()
    return [ReapedFailure(job_id=r.id, tenant_id=r.tenant_id, org_unit_id=r.org_unit_id) for r in rows]


def tenant_context_for(tenant_id: uuid.UUID) -> TenantContext:
    return TenantContext(tenant_id=str(tenant_id))


_QUEUE_DEPTH_STMT = text(
    "SELECT status, count(*) FROM scheduling.schedule_jobs "
    "WHERE status IN ('queued', 'solving') GROUP BY status"
)


async def get_queue_depth(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, int]:
    """§8's queue-depth metric - a live, pull-time query (`app/main.py`'s
    `/metrics` endpoint), not a push from `app.worker` (a separate OS
    process with its own in-memory Prometheus registry `/metrics` here
    could never see - see `app/core/worker_metrics.py`'s own module
    docstring). Platform-admin bypass, same as the claim/reap queries -
    queue depth is inherently a cross-tenant fact."""
    async with tenant_scoped_session(
        platform_admin_context(), session_factory=session_factory
    ) as admin_session:
        rows = (await admin_session.execute(_QUEUE_DEPTH_STMT)).all()
    depth = {"queued": 0, "solving": 0}
    depth.update({r.status: r.count for r in rows})
    return depth
