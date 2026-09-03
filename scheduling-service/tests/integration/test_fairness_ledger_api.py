"""Phase 3's end-to-end proof that §3.3's fairness bound genuinely spans
schedule runs, not just the current solve: publish a schedule (the
`FairnessLedger` refresh trigger), then submit a *second*, later job whose
feasibility is governed by history written by the *first* job's publish -
against the real FastAPI app, a real Postgres, and a real NATS.

Phase 7 (ADR-0060): `_submit` polls to terminal now - see
`test_jobs_solve_api.py`'s own module docstring.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import FairnessLedger
from app.db.session import tenant_scoped_session
from app.main import app
from tests.jwt_test_helpers import auth_headers

from .conftest import poll_until_terminal

pytestmark = pytest.mark.asyncio

_DEFAULT_POLICY = {
    "maxConsecutiveWorkingDays": 6,
    "minRestHoursBetweenShifts": 10.0,
    "minShiftLengthMinutes": 240,
    "maxShiftLengthMinutes": 600,
}


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _shift(day: date, start_hour: int, duration_hours: float, *, headcount: int = 1) -> dict[str, object]:
    # Explicit "Z" (UTC) suffix, never a bare naive timestamp - this test's
    # fairness assertions depend on the exact wall-clock hour landing inside
    # (or outside) the night window, and a naive ISO string gets interpreted
    # relative to whatever local timezone the process/DB session happens to
    # be running in, silently shifting the hour by that offset on its
    # round-trip through a `timestamptz` column - found by an assertion
    # that depended on it failing in a non-UTC sandbox, not by inspection.
    start = f"{day.isoformat()}T{start_hour:02d}:00:00Z"
    end_day = day if start_hour + duration_hours <= 24 else day + timedelta(days=1)
    end_hour = int((start_hour + duration_hours) % 24)
    return {
        "id": str(uuid.uuid4()),
        "start": start,
        "end": f"{end_day.isoformat()}T{end_hour:02d}:00:00Z",
        "requiredHeadcount": headcount,
    }


def _employee(employee_id: uuid.UUID | None = None) -> dict[str, object]:
    return {"id": str(employee_id or uuid.uuid4()), "contractHoursPerWeek": 40.0}


def _submit(client: TestClient, tenant_id: uuid.UUID, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    return poll_until_terminal(client, tenant_id, response.json()["jobId"])


def _get_schedule(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> dict[str, object]:
    response = client.get(f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    return dict(response.json())


def _publish(client: TestClient, tenant_id: uuid.UUID, schedule_id: str) -> object:
    return client.post(
        f"/v1/scheduling/schedules/{schedule_id}/publish", headers=auth_headers(tenant_id)
    )


async def test_publishing_a_schedule_writes_real_fairness_ledger_rows(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=10)
    employee = _employee()
    # 23:00-03:00 the night before `day` is "undesirable" under the platform
    # default night rule (22:00-06:00) - see fairness_service.py.
    night_shift = _shift(day, 23, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [employee],
        "shiftSlots": [night_shift],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        assert job["status"] == "completed"
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        publish_response = _publish(client, tenant_a_id, str(schedule["id"]))

    assert publish_response.status_code == 200, publish_response.text
    published = publish_response.json()
    assert published["status"] == "published"
    assert published["publishedAt"] is not None

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        rows = (
            await session.scalars(
                select(FairnessLedger).where(FairnessLedger.employee_id == uuid.UUID(employee["id"]))
            )
        ).all()
    assert len(rows) == 1
    assert rows[0].is_undesirable is True


async def test_publishing_an_already_published_schedule_is_rejected(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        first = _publish(client, tenant_a_id, str(schedule["id"]))
        second = _publish(client, tenant_a_id, str(schedule["id"]))

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "SCHEDULE_NOT_PUBLISHABLE"


async def test_publishing_a_nonexistent_schedule_returns_404(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = _publish(client, tenant_a_id, str(uuid.uuid4()))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_fairness_bound_spans_schedule_runs_via_the_published_ledger(tenant_a_id: uuid.UUID) -> None:
    """The actual §3.3 promise, proven end to end: history written by
    publishing job A's schedule constrains job B's feasibility, even though
    B is a completely separate solve submitted later."""
    burdened_id = uuid.uuid4()
    fresh_id = uuid.uuid4()
    earlier_day = date.today() + timedelta(days=3)
    later_day = date.today() + timedelta(days=10)

    with TestClient(app) as client:
        # Job A: 3 separate undesirable (night) shifts, all forced onto
        # `burdened_id` because `fresh_id` isn't in this job's roster at all.
        night_shifts_a = [_shift(earlier_day + timedelta(days=i), 23, 4) for i in range(3)]
        job_a_body = {
            "orgUnitId": str(uuid.uuid4()),
            "forecastRunId": str(uuid.uuid4()),
            "dateRange": {
                "start": earlier_day.isoformat(),
                "end": (earlier_day + timedelta(days=2)).isoformat(),
            },
            "policy": _DEFAULT_POLICY,
            "roster": [_employee(burdened_id)],
            "shiftSlots": night_shifts_a,
        }
        job_a = _submit(client, tenant_a_id, job_a_body)
        assert job_a["status"] == "completed"
        schedule_a = _get_schedule(client, tenant_a_id, str(job_a["id"]))
        publish_a = _publish(client, tenant_a_id, str(schedule_a["id"]))
        assert publish_a.status_code == 200

        # Job B: both employees now in the roster, fairness enforced with
        # zero tolerance - {burdened: 3, fresh: 0} can never split evenly
        # across a single new undesirable shift, so this must be infeasible
        # regardless of which employee the solver would otherwise pick.
        job_b_body = {
            "orgUnitId": str(uuid.uuid4()),
            "forecastRunId": str(uuid.uuid4()),
            "dateRange": {"start": later_day.isoformat(), "end": later_day.isoformat()},
            "policy": _DEFAULT_POLICY,
            "roster": [_employee(burdened_id), _employee(fresh_id)],
            "shiftSlots": [_shift(later_day, 23, 4)],
            "constraintConfig": {"fairness": {"rollingPeriodWeeks": 4, "tolerance": 0}},
        }
        job_b = _submit(client, tenant_a_id, job_b_body)
        assert job_b["status"] == "infeasible"

        # Same scenario, looser tolerance - now feasible, proving the bound
        # (not some unrelated hard constraint) was what blocked job B.
        job_c_body = dict(
            job_b_body, constraintConfig={"fairness": {"rollingPeriodWeeks": 4, "tolerance": 2}}
        )
        job_c = _submit(client, tenant_a_id, job_c_body)
        assert job_c["status"] == "completed"


async def test_fairness_audit_endpoint_reports_counts_and_tolerance_violations(
    tenant_a_id: uuid.UUID,
) -> None:
    """The module prompt's own compliance-auditor bar, exercised for real:
    "show me the fairness tolerance policy in effect for period X and prove
    no employee exceeded it." """
    employee_a_id = uuid.uuid4()
    employee_b_id = uuid.uuid4()
    day = date.today() + timedelta(days=15)

    with TestClient(app) as client:
        # A single undesirable (night) shift needing both employees at once
        # (headcount=2) - both end up with exactly one undesirable shift
        # each, a perfectly balanced ledger. No fairness bound is configured
        # on this job; this test is about the audit query reading the
        # ledger back correctly, not about enforcement.
        body = {
            "orgUnitId": str(uuid.uuid4()),
            "forecastRunId": str(uuid.uuid4()),
            "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
            "policy": _DEFAULT_POLICY,
            "roster": [_employee(employee_a_id), _employee(employee_b_id)],
            "shiftSlots": [_shift(day, 23, 4, headcount=2)],
        }
        job = _submit(client, tenant_a_id, body)
        assert job["status"] == "completed"
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        publish = _publish(client, tenant_a_id, str(schedule["id"]))
        assert publish.status_code == 200

        period_start = day - timedelta(days=1)
        period_end = day + timedelta(days=2)
        audit_response = client.get(
            "/v1/scheduling/fairness/audit",
            params={
                "periodStart": period_start.isoformat(),
                "periodEnd": period_end.isoformat(),
                "tolerance": 0,
            },
            headers=auth_headers(tenant_a_id),
        )

    assert audit_response.status_code == 200, audit_response.text
    audit = audit_response.json()
    entries = {e["employeeId"]: e for e in audit["employees"]}
    # Both employees were assigned to the 23:00 (undesirable) shift, since
    # its requiredHeadcount is 2 and both are eligible - each has exactly
    # one undesirable shift, so the group is already perfectly balanced.
    assert entries[str(employee_a_id)]["undesirableShiftCount"] == 1
    assert entries[str(employee_b_id)]["undesirableShiftCount"] == 1
    assert entries[str(employee_a_id)]["exceededTolerance"] is False
    assert entries[str(employee_b_id)]["exceededTolerance"] is False
    assert audit["averageUndesirableShiftCount"] == 1.0
