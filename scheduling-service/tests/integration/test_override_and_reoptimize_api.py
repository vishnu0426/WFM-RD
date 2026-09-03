"""Phase 5's end-to-end §2.2 rule 1 proof: a manual override
(`POST .../assignments/{id}/override`) is persisted with
`assignmentSource: manual_override` / `locked: true`, and a subsequent
re-optimization (`POST .../reoptimize`) forces that same pair via
`SolveInput.locked_assignments` (ADR-0058) rather than silently re-solving
it away - against the real FastAPI app, a real Postgres, and a real NATS.

Phase 7 (ADR-0060): both submission and reoptimize only enqueue now -
`_submit_job`/`_reoptimize` poll to terminal before returning. Locked-shift/
locked-employee matching for reoptimize used to be synchronous 422s (Phase
5); that validation now runs worker-side, so a mismatch surfaces as an
async `failed` job with a structured `failureReason` instead (ADR-0060
Decision 5) - enqueue-time checks (schedule exists/not archived,
idempotency) remain synchronous.
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


def _submit_job(client: TestClient, tenant_id: uuid.UUID, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job = poll_until_terminal(client, tenant_id, response.json()["jobId"])
    assert job["status"] == "completed", job
    return job


def _reoptimize(
    client: TestClient,
    tenant_id: uuid.UUID,
    schedule_id: str,
    body: dict[str, object],
    *,
    headers: dict[str, str] | None = None,
) -> dict[str, object]:
    response = client.post(
        f"/v1/scheduling/schedules/{schedule_id}/reoptimize",
        json=body,
        headers=headers or _headers(tenant_id),
    )
    assert response.status_code in (200, 201), response.text
    job_id = response.json()["jobId"]
    return poll_until_terminal(client, tenant_id, job_id)


def _index_by_shift_start(assignments: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    # Response `shiftStart` round-trips through Postgres and comes back
    # `Z`-suffixed; request `shift()` dicts build their `start` via plain
    # `datetime.isoformat()`, which is `+00:00`-suffixed - normalize both
    # through `fromisoformat` so lookups by the request's own `start` string
    # work regardless of which suffix either side used.
    return {
        datetime.fromisoformat(str(a["shiftStart"])).isoformat(): a for a in assignments
    }


def _get_schedule(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> dict[str, object]:
    response = client.get(f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    return dict(response.json())


async def test_override_reassigns_and_marks_manual_override(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        assignment = schedule["assignments"][0]
        assert assignment["assignmentSource"] == "auto_generated"
        assert assignment["locked"] is False

        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/assignments/{assignment['id']}/override",
            json={"employeeId": e2["id"]},
            headers=auth_headers(tenant_a_id),
        )

    assert override_response.status_code == 200, override_response.text
    overridden = override_response.json()
    assert overridden["employeeId"] == e2["id"]
    assert overridden["assignmentSource"] == "manual_override"
    assert overridden["locked"] is True


async def test_override_on_a_double_booking_records_a_schedule_conflict(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift_a = _shift(day, 9, 4)  # 09:00-13:00, assigned to e1
    shift_b = _shift(day, 11, 4)  # 11:00-15:00, overlaps shift_a, assigned to e2
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift_a, shift_b],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        by_shift_start = _index_by_shift_start(schedule["assignments"])
        assignment_b = by_shift_start[shift_b["start"]]

        # Override shift_b onto whichever employee already has shift_a -
        # forces a real double-booking on purpose.
        assignment_a = by_shift_start[shift_a["start"]]
        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/assignments/{assignment_b['id']}/override",
            json={"employeeId": assignment_a["employeeId"]},
            headers=auth_headers(tenant_a_id),
        )
        assert override_response.status_code == 200, override_response.text

        conflicts_response = client.get(
            f"/v1/scheduling/schedules/{schedule_id}/conflicts", headers=auth_headers(tenant_a_id)
        )

    assert conflicts_response.status_code == 200, conflicts_response.text
    conflicts = conflicts_response.json()
    assert len(conflicts) == 1
    assert conflicts[0]["conflictType"] == "double_booking"
    assert conflicts[0]["affectedEmployeeId"] == assignment_a["employeeId"]
    assert conflicts[0]["status"] == "open"


async def test_override_on_a_nonexistent_assignment_returns_404(tenant_a_id: uuid.UUID) -> None:
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
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))

        response = client.post(
            f"/v1/scheduling/schedules/{schedule['id']}/assignments/{uuid.uuid4()}/override",
            json={"employeeId": str(uuid.uuid4())},
            headers=auth_headers(tenant_a_id),
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_reoptimize_keeps_the_override_and_fills_the_rest(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2, e3 = _employee(), _employee(), _employee()
    shift_a = _shift(day, 9, 4)
    shift_b = _shift(day, 15, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [shift_a, shift_b],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        by_shift_start = _index_by_shift_start(schedule["assignments"])
        assignment_a = by_shift_start[shift_a["start"]]

        # Manually override shift_a onto e3, who wasn't even in the
        # original roster - a real out-of-band decision.
        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/assignments/{assignment_a['id']}/override",
            json={"employeeId": e3["id"]},
            headers=auth_headers(tenant_a_id),
        )
        assert override_response.status_code == 200, override_response.text

        # Reoptimize: e3 must be in the resupplied roster (ADR-0058's
        # forced variable needs an Employee to build a decision variable
        # for), and both shifts must be resupplied so the locked shift_a
        # can be matched by (start, end, requiredSkillId).
        reoptimize_body = {
            "policy": _DEFAULT_POLICY,
            "roster": [e1, e2, e3],
            "shiftSlots": [shift_a, shift_b],
        }
        new_job = _reoptimize(client, tenant_a_id, schedule_id, reoptimize_body)
        assert new_job["status"] == "completed", new_job

        new_schedule = _get_schedule(client, tenant_a_id, str(new_job["id"]))

    new_by_shift_start = _index_by_shift_start(new_schedule["assignments"])
    # shift_a stayed locked onto e3, with its manual_override source intact.
    assert new_by_shift_start[shift_a["start"]]["employeeId"] == e3["id"]
    assert new_by_shift_start[shift_a["start"]]["assignmentSource"] == "manual_override"
    assert new_by_shift_start[shift_a["start"]]["locked"] is True
    # shift_b was freely solved among the roster (e1 or e2 - either is fine).
    assert new_by_shift_start[shift_b["start"]]["employeeId"] in {e1["id"], e2["id"]}
    assert new_by_shift_start[shift_b["start"]]["assignmentSource"] == "auto_generated"


async def test_reoptimize_without_the_locked_shift_in_the_request_is_rejected(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift_a = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1],
        "shiftSlots": [shift_a],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        assignment_a = schedule["assignments"][0]

        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/assignments/{assignment_a['id']}/override",
            json={"employeeId": e2["id"]},
            headers=auth_headers(tenant_a_id),
        )
        assert override_response.status_code == 200, override_response.text

        # Reoptimize request resupplies a *different* shift, omitting the
        # now-locked shift_a entirely. Phase 7: this match now happens
        # worker-side, so enqueue succeeds and the job resolves `failed`.
        different_shift = _shift(day, 20, 4)
        reoptimize_body = {
            "policy": _DEFAULT_POLICY,
            "roster": [e1, e2],
            "shiftSlots": [different_shift],
        }
        response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/reoptimize",
            json=reoptimize_body,
            headers=_headers(tenant_a_id),
        )
        assert response.status_code == 201, response.text
        job = poll_until_terminal(client, tenant_a_id, response.json()["jobId"])

    assert job["status"] == "failed", job
    assert job["relaxationsApplied"]["failureReason"]["code"] == "LOCKED_SHIFT_MISSING_FROM_REQUEST"


async def test_reoptimize_without_the_locked_employee_in_the_roster_is_rejected(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = _employee(), _employee()
    shift_a = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1],
        "shiftSlots": [shift_a],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]
        assignment_a = schedule["assignments"][0]

        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/assignments/{assignment_a['id']}/override",
            json={"employeeId": e2["id"]},
            headers=auth_headers(tenant_a_id),
        )
        assert override_response.status_code == 200, override_response.text

        # Reoptimize resupplies shift_a (so the locked-shift match succeeds)
        # but omits e2 from the roster entirely. Phase 7: this match now
        # happens worker-side, so enqueue succeeds and the job resolves
        # `failed`.
        reoptimize_body = {
            "policy": _DEFAULT_POLICY,
            "roster": [e1],
            "shiftSlots": [shift_a],
        }
        response = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/reoptimize",
            json=reoptimize_body,
            headers=_headers(tenant_a_id),
        )
        assert response.status_code == 201, response.text
        job = poll_until_terminal(client, tenant_a_id, response.json()["jobId"])

    assert job["status"] == "failed", job
    assert job["relaxationsApplied"]["failureReason"]["code"] == "LOCKED_ASSIGNMENT_EMPLOYEE_MISSING"


async def test_reoptimize_is_idempotent_on_the_same_key(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1 = _employee()
    shift_a = _shift(day, 9, 4)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1],
        "shiftSlots": [shift_a],
    }
    with TestClient(app) as client:
        job = _submit_job(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        schedule_id = schedule["id"]

        reoptimize_body = {"policy": _DEFAULT_POLICY, "roster": [e1], "shiftSlots": [shift_a]}
        headers = _headers(tenant_a_id)
        first = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/reoptimize", json=reoptimize_body, headers=headers
        )
        second = client.post(
            f"/v1/scheduling/schedules/{schedule_id}/reoptimize", json=reoptimize_body, headers=headers
        )

    assert first.status_code == 201, first.text
    assert second.status_code == 200, second.text
    assert first.json()["jobId"] == second.json()["jobId"]
