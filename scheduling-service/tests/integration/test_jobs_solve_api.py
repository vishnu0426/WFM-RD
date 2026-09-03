"""Phase 2's end-to-end contract test: `POST /v1/scheduling/jobs` with a full
solve-input payload (ADR-0055) against the real FastAPI app, a real Postgres
(Phase 1 migration applied), and a real NATS - proving the CP-SAT wiring
(not just the pure-engine unit suite in test_solver_constraints.py) produces
real, persisted `Schedule`/`ShiftAssignment` rows reachable over HTTP.

Phase 7 (ADR-0060): `POST` only enqueues now - every test here submits, then
`poll_until_terminal` (conftest.py) waits for the real `app/worker.py`
subprocess (session-scoped fixture, also conftest.py) to actually solve it.
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
    "maxConsecutiveWorkingDays": 5,
    "minRestHoursBetweenShifts": 10.0,
    "minShiftLengthMinutes": 240,
    "maxShiftLengthMinutes": 600,
    "mandatoryBreakAfterHours": 6.0,
    "mandatoryBreakMinutes": 30,
}


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _shift(day: date, start_hour: int, duration_hours: float, *, headcount: int = 1) -> dict[str, object]:
    # tzinfo=UTC explicitly, not a naive datetime - a naive `.isoformat()`
    # string gets reinterpreted relative to whatever local timezone the
    # process/DB session happens to run in on its round-trip through a
    # `timestamptz` column (see test_fairness_ledger_api.py's `_shift` for
    # the full story of where this bit a fairness-hour-dependent assertion).
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    end = start + timedelta(hours=duration_hours)
    return {
        "id": str(uuid.uuid4()),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "requiredHeadcount": headcount,
        "breakMinutes": 30,
    }


def _employee(*, contract_hours: float = 40.0, overtime_approved: bool = False) -> dict[str, object]:
    return {
        "id": str(uuid.uuid4()),
        "contractHoursPerWeek": contract_hours,
        "overtimeApproved": overtime_approved,
    }


async def test_submit_job_with_solvable_input_produces_a_completed_schedule(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=3)
    employee = _employee()
    shift = _shift(day, 9, 8)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [employee],
        "shiftSlots": [shift],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        assert submit_response.status_code == 201, submit_response.text
        assert submit_response.json()["status"] == "queued"
        job_id = submit_response.json()["jobId"]

        job_detail = poll_until_terminal(client, tenant_a_id, job_id)
        assert job_detail["status"] == "completed"
        assert job_detail["solveDurationMs"] is not None
        assert job_detail["completedAt"] is not None

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    assert schedule_response.status_code == 200, schedule_response.text
    schedule = schedule_response.json()
    assert schedule["status"] == "draft"
    assert len(schedule["assignments"]) == 1
    assignment = schedule["assignments"][0]
    assert assignment["employeeId"] == employee["id"]
    assert assignment["assignmentSource"] == "auto_generated"
    assert assignment["locked"] is False
    assert assignment["isOvertime"] is False


async def test_submit_job_that_is_infeasible_reports_infeasible_and_no_schedule(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=3)
    # Coverage requires 2, only 1 employee supplied - structurally infeasible.
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [_shift(day, 9, 8, headcount=2)],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        assert submit_response.status_code == 201, submit_response.text
        job_id = submit_response.json()["jobId"]

        job_detail = poll_until_terminal(client, tenant_a_id, job_id)
        assert job_detail["status"] == "infeasible"

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    assert schedule_response.status_code == 404
    assert schedule_response.json()["error"]["code"] == "NOT_FOUND"


async def test_overtime_approved_employee_is_flagged_as_overtime_on_the_persisted_assignment(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=3)
    employee = _employee(contract_hours=4.0, overtime_approved=True)  # 240min/week cap, 480min shift
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [employee],
        "shiftSlots": [_shift(day, 9, 8)],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        assert submit_response.status_code == 201
        job_id = submit_response.json()["jobId"]
        poll_until_terminal(client, tenant_a_id, job_id)

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    assert schedule_response.json()["assignments"][0]["isOvertime"] is True


async def test_shift_violating_union_rules_is_rejected_async_and_creates_no_schedule(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=3)
    headers = _headers(tenant_a_id)
    bad_shift = _shift(day, 9, 1)  # 1h < 240min minimum shift length
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [bad_shift],
    }
    with TestClient(app) as client:
        # Phase 7 (ADR-0060 Decision 5): a union-rule violation used to be a
        # synchronous 422 (Phase 2). There's no HTTP response to attach it
        # to anymore once solving moved to the worker - the job resolves to
        # `failed` with the same structured reason instead.
        submitted = client.post("/v1/scheduling/jobs", json=body, headers=headers)
        assert submitted.status_code == 201, submitted.text
        job_id = submitted.json()["jobId"]

        job_detail = poll_until_terminal(client, tenant_a_id, job_id)
        assert job_detail["status"] == "failed"
        assert job_detail["relaxationsApplied"]["failureReason"]["code"] == "INVALID_SHIFT_DEFINITION"

        # A *new* Idempotency-Key with a corrected body still succeeds -
        # the failed job's own key was consumed by the failed attempt (a
        # deliberate, real outcome now that `failed` is reached
        # asynchronously rather than the request itself being rejected
        # before any row was ever created).
        good_body = dict(body, shiftSlots=[_shift(day, 9, 8)])
        retried = client.post("/v1/scheduling/jobs", json=good_body, headers=_headers(tenant_a_id))
        assert retried.status_code == 201, retried.text
        retried_detail = poll_until_terminal(client, tenant_a_id, retried.json()["jobId"])

    assert retried_detail["status"] == "completed"


async def test_leave_and_skill_gate_a_realistic_two_employee_scenario(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=3)
    skill_id = str(uuid.uuid4())
    qualified = _employee()
    qualified["skills"] = [{"skillId": skill_id}]
    unqualified = _employee()
    shift = _shift(day, 9, 8)
    shift["requiredSkillId"] = skill_id
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [qualified, unqualified],
        "shiftSlots": [shift],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        job_id = submit_response.json()["jobId"]
        job_detail = poll_until_terminal(client, tenant_a_id, job_id)
        assert job_detail["status"] == "completed"

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_a_id)
        )

    assignments = schedule_response.json()["assignments"]
    assert len(assignments) == 1
    assert assignments[0]["employeeId"] == qualified["id"]
    assert assignments[0]["skillId"] == skill_id
