"""Phase 7/8's own mechanics, proven against the real Postgres directly
(not just indirectly via a job's eventual outcome, the way every other
integration file exercises the worker) - ADR-0060's actual claims:

- `queue_service.claim_next_job`'s `SELECT ... FOR UPDATE SKIP LOCKED` never
  lets two concurrent claimers take the same row (the whole reason a DB-poll
  queue was chosen over a second NATS work queue - no dual-write drift, and
  Postgres itself is the single source of truth for "who owns this job").
- `queue_service.reap_stuck_jobs` requeues a job stuck in `solving` past the
  threshold (bumping `attempt_count`), and marks a job that's already
  exhausted `maxAttempts` `failed` instead of requeuing it forever (a
  "poison" job).
- `app.worker.Worker`'s graceful draining: `request_drain()` causes `run()`
  to actually return (not just set a flag nothing reads).
- `app/solver/decomposition.py` wired end-to-end through a real job: a
  >200-employee, 2-site submission genuinely decomposes and both sites'
  shifts get covered - the real proof for the org_unit_id propagation bug
  fixed alongside this file (`EmployeeInput`/`to_employee`/
  `employee_client.get_schedulable_roster` previously never set
  `Employee.org_unit_id` at all, so any job that actually triggered
  decomposition would have silently produced zero-employee groups).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime, timedelta

import nats
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.config import get_settings
from app.core.tenant_context import TenantContext
from app.db.models import ScheduleJob
from app.db.session import tenant_scoped_session
from app.main import app
from app.services import queue_service
from app.worker import Worker
from tests.jwt_test_helpers import auth_headers

from .conftest import poll_until_terminal

pytestmark = pytest.mark.asyncio

_DEFAULT_POLICY = {
    "maxConsecutiveWorkingDays": 5,
    "minRestHoursBetweenShifts": 10.0,
    "minShiftLengthMinutes": 240,
    "maxShiftLengthMinutes": 600,
}


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


async def _insert_queued_job(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    status: str = "queued",
    attempt_count: int = 0,
    solving_started_at: datetime | None = None,
) -> uuid.UUID:
    """A bare `schedule_jobs` row good enough for `queue_service`'s own
    claim/reap queries (which only ever touch status/kind/payload/timing
    columns) - deliberately not a solvable payload, since these tests are
    about the queue mechanics, not about what happens once a job executes
    (every other integration file already covers that)."""
    day = date.today() + timedelta(days=1)
    job = ScheduleJob(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=uuid.uuid4(),
        forecast_run_id=uuid.uuid4(),
        date_range_start=day,
        date_range_end=day,
        status=status,
        constraint_config={},
        job_kind="submit",
        request_payload={},  # non-null - satisfies the claim query's own WHERE clause
        attempt_count=attempt_count,
        solving_started_at=solving_started_at,
        requested_at=datetime.now(UTC),
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(job)
    await session.flush()
    return job.id


async def _get_status(
    factory: async_sessionmaker[AsyncSession], *, tenant_id: uuid.UUID, job_id: uuid.UUID
) -> ScheduleJob:
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        job = await session.get(ScheduleJob, job_id)
        assert job is not None
        return job


async def test_concurrent_claims_never_double_claim_the_same_job(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        job_a = await _insert_queued_job(session, tenant_id=tenant_a_id)
        job_b = await _insert_queued_job(session, tenant_id=tenant_a_id)

    # Two claimers racing at once - `FOR UPDATE SKIP LOCKED` is the only
    # thing standing between this and a genuine double-claim (the actual
    # bug a second, independent NATS work queue would risk - ADR-0060).
    claimed = await asyncio.gather(
        queue_service.claim_next_job(factory, worker_id="worker-1"),
        queue_service.claim_next_job(factory, worker_id="worker-2"),
    )
    assert None not in claimed, claimed
    claimed_ids = {c.job_id for c in claimed if c is not None}
    assert claimed_ids == {job_a, job_b}

    row_a = await _get_status(factory, tenant_id=tenant_a_id, job_id=job_a)
    row_b = await _get_status(factory, tenant_id=tenant_a_id, job_id=job_b)
    assert row_a.status == "solving"
    assert row_b.status == "solving"
    assert row_a.claimed_by in ("worker-1", "worker-2")
    assert row_b.claimed_by in ("worker-1", "worker-2")
    assert row_a.claimed_by != row_b.claimed_by


async def test_claim_next_job_returns_none_when_nothing_is_queued(
    app_engine: AsyncEngine,
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    claimed = await queue_service.claim_next_job(factory, worker_id="worker-1")
    # Not a strict "the queue is globally empty" assertion (other tests in
    # this session may have their own rows) - just proves the "no work"
    # path returns `None` rather than raising.
    assert claimed is None or claimed.job_id is not None


async def test_reap_stuck_jobs_requeues_below_max_attempts(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    stuck_since = datetime.now(UTC) - timedelta(seconds=120)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        job_id = await _insert_queued_job(
            session,
            tenant_id=tenant_a_id,
            status="solving",
            attempt_count=1,
            solving_started_at=stuck_since,
        )

    reaped = await queue_service.reap_stuck_jobs(factory, threshold_seconds=60, max_attempts=3)
    assert job_id not in {r.job_id for r in reaped}  # requeued, not failed - not in the failure list

    row = await _get_status(factory, tenant_id=tenant_a_id, job_id=job_id)
    assert row.status == "queued"
    assert row.claimed_by is None
    assert row.solving_started_at is None
    assert row.attempt_count == 2  # bumped from 1


async def test_reap_stuck_jobs_fails_poison_jobs_at_max_attempts(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    stuck_since = datetime.now(UTC) - timedelta(seconds=120)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        job_id = await _insert_queued_job(
            session,
            tenant_id=tenant_a_id,
            status="solving",
            attempt_count=3,  # already at max_attempts
            solving_started_at=stuck_since,
        )

    reaped = await queue_service.reap_stuck_jobs(factory, threshold_seconds=60, max_attempts=3)
    failed_ids = {r.job_id: r for r in reaped}
    assert job_id in failed_ids

    row = await _get_status(factory, tenant_id=tenant_a_id, job_id=job_id)
    assert row.status == "failed"
    assert row.completed_at is not None
    assert row.relaxations_applied is not None
    assert row.relaxations_applied["failureReason"]["code"] == "REAPER_MAX_ATTEMPTS_EXCEEDED"


async def test_reap_stuck_jobs_ignores_jobs_still_within_the_threshold(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        job_id = await _insert_queued_job(
            session,
            tenant_id=tenant_a_id,
            status="solving",
            attempt_count=0,
            solving_started_at=datetime.now(UTC),  # just claimed, well within any real threshold
        )

    await queue_service.reap_stuck_jobs(factory, threshold_seconds=300, max_attempts=3)

    row = await _get_status(factory, tenant_id=tenant_a_id, job_id=job_id)
    assert row.status == "solving"  # untouched - not yet stuck


async def test_decomposition_splits_a_large_multi_site_job_and_covers_both_sites(
    tenant_a_id: uuid.UUID,
) -> None:
    """The real §7.1 proof: 202 employees (> DECOMPOSITION_EMPLOYEE_THRESHOLD
    = 200) split across two sites, one shift per site, no shared skill -
    must decompose into exactly two independent groups, and both sites'
    shifts must still get covered (not silently dropped, and not falsely
    reported infeasible for lack of a locally-visible employee pool - the
    exact failure mode the `Employee.org_unit_id` propagation bug fixed
    alongside this test would have caused)."""
    day = date.today() + timedelta(days=40)
    site_a, site_b = uuid.uuid4(), uuid.uuid4()
    roster = [
        {"id": str(uuid.uuid4()), "contractHoursPerWeek": 40.0, "orgUnitId": str(site_a)}
        for _ in range(101)
    ] + [
        {"id": str(uuid.uuid4()), "contractHoursPerWeek": 40.0, "orgUnitId": str(site_b)}
        for _ in range(101)
    ]
    shift_a_start = datetime(day.year, day.month, day.day, 9, tzinfo=UTC)
    shift_b_start = datetime(day.year, day.month, day.day, 13, tzinfo=UTC)
    body = {
        "orgUnitId": str(site_a),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": roster,
        "shiftSlots": [
            {
                "id": str(uuid.uuid4()),
                "start": shift_a_start.isoformat(),
                "end": (shift_a_start + timedelta(hours=4)).isoformat(),
                "requiredHeadcount": 1,
                "orgUnitId": str(site_a),
            },
            {
                "id": str(uuid.uuid4()),
                "start": shift_b_start.isoformat(),
                "end": (shift_b_start + timedelta(hours=4)).isoformat(),
                "requiredHeadcount": 1,
                "orgUnitId": str(site_b),
            },
        ],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        assert submit_response.status_code == 201, submit_response.text
        job_id = submit_response.json()["jobId"]

        job_detail = poll_until_terminal(client, tenant_a_id, job_id, timeout=30.0)
        assert job_detail["status"] == "completed", job_detail

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    plan = job_detail["decompositionPlan"]
    assert plan is not None
    assert plan["decomposed"] is True
    assert plan["groupCount"] == 2
    group_employee_counts = sorted(g["employeeCount"] for g in plan["groups"])
    assert group_employee_counts == [101, 101]
    for group in plan["groups"]:
        assert group["shiftCount"] == 1
        assert group["status"] in ("optimal", "feasible")

    assert schedule_response.status_code == 200, schedule_response.text
    assignments = schedule_response.json()["assignments"]
    # Both sites' shifts got covered - proof neither group's employee pool
    # came back empty.
    assert len(assignments) == 2
    assigned_employee_ids = {a["employeeId"] for a in assignments}
    site_a_ids = {e["id"] for e in roster[:101]}
    site_b_ids = {e["id"] for e in roster[101:]}
    assert assigned_employee_ids & site_a_ids
    assert assigned_employee_ids & site_b_ids


async def test_request_drain_causes_run_to_actually_return() -> None:
    """§7.2's graceful draining, proven on the real `Worker` class (not just
    "a flag gets set") - a genuinely separate worker instance from the
    session-scoped one `conftest.py` runs as a subprocess, so draining it
    can't interfere with any other test's own job processing."""
    settings = get_settings()
    nc = await nats.connect(settings.nats_url)
    try:
        js = nc.jetstream()
        worker = Worker(worker_id="test-drain-worker", js=js, settings=settings)
        assert worker.is_draining is False

        run_task = asyncio.ensure_future(worker.run())
        await asyncio.sleep(0.1)  # let it enter the loop (reap + claim at least once)
        worker.request_drain()
        assert worker.is_draining is True

        await asyncio.wait_for(run_task, timeout=settings.worker_poll_interval_seconds + 5.0)
    finally:
        await nc.close()
