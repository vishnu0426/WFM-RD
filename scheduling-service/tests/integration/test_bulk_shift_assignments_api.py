"""Proves `GET /v1/scheduling/shift-assignments` (the bulk-by-employee-ids
counterpart to `employees.py`'s per-employee endpoint, added for the
web-console roster board) against the real FastAPI app + Postgres, same
posture as `test_employee_shift_assignments_api.py`.
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


def _employee(employee_id: uuid.UUID | None = None) -> dict[str, object]:
    return {"id": str(employee_id or uuid.uuid4()), "contractHoursPerWeek": 40.0}


def _window(day: date, days: int = 1) -> dict[str, str]:
    return {
        "from": f"{day.isoformat()}T00:00:00Z",
        "to": f"{(day + timedelta(days=days)).isoformat()}T00:00:00Z",
    }


def _submit(client: TestClient, tenant_id: uuid.UUID, body: dict[str, object]) -> dict[str, object]:
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job = poll_until_terminal(client, tenant_id, response.json()["jobId"])
    assert job["status"] == "completed", job
    return job


def _get_schedule(client: TestClient, tenant_id: uuid.UUID, job_id: str) -> dict[str, object]:
    response = client.get(f"/v1/scheduling/jobs/{job_id}/schedule", headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    return dict(response.json())


def _publish(client: TestClient, tenant_id: uuid.UUID, schedule_id: str) -> object:
    return client.post(f"/v1/scheduling/schedules/{schedule_id}/publish", headers=auth_headers(tenant_id))


def _bulk(client: TestClient, tenant_id: uuid.UUID, employee_ids: list[uuid.UUID], day: date, days: int = 1):
    return client.get(
        "/v1/scheduling/shift-assignments",
        params={"employeeIds": [str(e) for e in employee_ids], **_window(day, days)},
        headers=auth_headers(tenant_id),
    )


async def test_returns_published_assignments_for_every_requested_employee(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2 = uuid.uuid4(), uuid.uuid4()
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee(e1), _employee(e2)],
        "shiftSlots": [_shift(day, 9, 4, headcount=2)],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        _publish(client, tenant_a_id, str(schedule["id"]))

        response = _bulk(client, tenant_a_id, [e1, e2], day)

    assert response.status_code == 200, response.text
    results = response.json()
    assert {r["employeeId"] for r in results} == {str(e1), str(e2)}
    assert all(r["scheduleId"] == schedule["id"] for r in results)


async def test_excludes_a_draft_schedules_assignments(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=11)
    employee_id = uuid.uuid4()
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee(employee_id)],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        _submit(client, tenant_a_id, body)  # never published

        response = _bulk(client, tenant_a_id, [employee_id], day)

    assert response.status_code == 200, response.text
    assert response.json() == []


async def test_excludes_assignments_outside_the_requested_window(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=12)
    employee_id = uuid.uuid4()
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee(employee_id)],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        _publish(client, tenant_a_id, str(schedule["id"]))

        # A window entirely before the shift's day never overlaps.
        earlier_window = _bulk(client, tenant_a_id, [employee_id], day - timedelta(days=5))

    assert earlier_window.status_code == 200, earlier_window.text
    assert earlier_window.json() == []


async def test_empty_employee_ids_returns_empty_list_without_error(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=13)
    with TestClient(app) as client:
        response = client.get(
            "/v1/scheduling/shift-assignments",
            params=_window(day),
            headers=auth_headers(tenant_a_id),
        )
    # No `employeeIds` supplied at all — FastAPI treats the required
    # repeated query param as an empty list, not a validation error, since
    # `Query(alias="employeeIds")` with a `list[uuid.UUID]` annotation and
    # no items present binds to `[]`.
    assert response.status_code == 200, response.text
    assert response.json() == []


async def test_bulk_shift_assignments_are_tenant_isolated(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=14)
    employee_id = uuid.uuid4()
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee(employee_id)],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        _publish(client, tenant_a_id, str(schedule["id"]))

        cross_tenant = _bulk(client, tenant_b_id, [employee_id], day)

    assert cross_tenant.status_code == 200, cross_tenant.text
    assert cross_tenant.json() == []
