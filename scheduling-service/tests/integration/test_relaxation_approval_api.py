"""Phase 4's end-to-end §5 proof: a job that solves `infeasible` gets a
real, structured relaxation option recorded (`relaxationsApplied`), nothing
is auto-applied, and a human explicitly approving it
(`POST /{jobId}/relaxation/approve`) is the only way it ever becomes a real,
persisted `Schedule` - against the real FastAPI app, a real Postgres, and a
real NATS.

Phase 7 (ADR-0060): submission only enqueues now - `_submit` polls to
terminal before returning. Approval itself is still synchronously
validated (job-not-infeasible/no-feasible-relaxation/already-approved all
stay real-time `409`s, ADR-0060's own "fast enqueue-time checks stay
synchronous" posture) - only the actual re-solve-and-persist moved to the
worker, so a successful approval still needs `poll_until_terminal` before
its `Schedule` is readable.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

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
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    end = start + timedelta(hours=duration_hours)
    return {
        "id": str(uuid.uuid4()),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "requiredHeadcount": headcount,
    }


def _employee(*, contract_hours: float = 40.0, overtime_approved: bool = False) -> dict[str, object]:
    return {
        "id": str(uuid.uuid4()),
        "contractHoursPerWeek": contract_hours,
        "overtimeApproved": overtime_approved,
    }


def _submit(client: TestClient, tenant_id: uuid.UUID, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job_id = response.json()["jobId"]
    return poll_until_terminal(client, tenant_id, job_id)


def _approve(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> object:
    return client.post(
        f"/v1/scheduling/jobs/{job_id}/relaxation/approve", headers=auth_headers(tenant_id)
    )


def _get_job_detail(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> dict[str, object]:
    response = client.get(f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    return dict(response.json())


def _contracted_hours_infeasible_job_body(day: date) -> dict[str, object]:
    # 240min/week cap, single 480min shift, single non-approved employee -
    # infeasible only because of the contracted-hours cap.
    employee = _employee(contract_hours=4.0, overtime_approved=False)
    return {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [employee],
        "shiftSlots": [_shift(day, 9, 8)],
    }


async def test_infeasible_job_records_a_feasible_relaxation_option(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=20)
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, _contracted_hours_infeasible_job_body(day))

    assert job["status"] == "infeasible"
    relaxations = job["relaxationsApplied"]
    assert relaxations is not None
    assert relaxations["attemptedCategories"] == ["contracted_hours"]
    assert relaxations["feasible"] is True
    assert relaxations["approved"] is False
    assert relaxations["approvedAt"] is None
    assert "overtime" in relaxations["explanation"].lower()
    assert relaxations["costSummary"]["contracted_hours"]["totalAdditionalOvertimeMinutes"] == 240


async def test_approving_a_relaxation_creates_a_real_schedule(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=20)
    body = _contracted_hours_infeasible_job_body(day)
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        job_id = str(job["id"])

        approve_response = _approve(client, tenant_a_id, job_id)
        assert approve_response.status_code == 200, approve_response.text
        approved_job = poll_until_terminal(client, tenant_a_id, job_id)
        assert approved_job["status"] == "completed"
        assert approved_job["relaxationsApplied"]["approved"] is True
        assert approved_job["relaxationsApplied"]["approvedAt"] is not None

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    assert schedule_response.status_code == 200, schedule_response.text
    assignments = schedule_response.json()["assignments"]
    assert len(assignments) == 1
    assert assignments[0]["isOvertime"] is True


async def test_approving_the_same_relaxation_twice_is_rejected(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=20)
    body = _contracted_hours_infeasible_job_body(day)
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        job_id = str(job["id"])
        first = _approve(client, tenant_a_id, job_id)
        assert first.status_code == 200, first.text
        poll_until_terminal(client, tenant_a_id, job_id)  # let the first approval actually finish

        second = _approve(client, tenant_a_id, job_id)

    assert second.status_code == 409
    assert second.json()["error"]["code"] == "RELAXATION_NOT_AVAILABLE"


async def test_approving_a_feasible_jobs_relaxation_is_rejected(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=20)
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
        assert job["status"] == "completed"
        response = _approve(client, tenant_a_id, str(job["id"]))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "RELAXATION_NOT_AVAILABLE"


async def test_approving_a_job_with_no_feasible_relaxation_is_rejected(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=20)
    skill_id = str(uuid.uuid4())
    shift = _shift(day, 9, 4)
    shift["requiredSkillId"] = skill_id
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],  # no one has the required skill
        "shiftSlots": [shift],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        assert job["status"] == "infeasible"
        assert job["relaxationsApplied"]["feasible"] is False

        response = _approve(client, tenant_a_id, str(job["id"]))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "RELAXATION_NOT_AVAILABLE"
    assert "no feasible relaxation" in response.json()["error"]["message"]


async def test_approving_a_nonexistent_job_returns_404(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = _approve(client, tenant_a_id, str(uuid.uuid4()))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
