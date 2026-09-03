"""Module 05 Phase 2 (§2.2 rule 2, docs/adr/0064): proves scheduling-service's
new employee-scoped read endpoint and the two new NATS events
(`schedule.published`/`assignment.changed`) actually work end to end -
against the real FastAPI app, a real Postgres, and a real NATS+JetStream
broker, same posture as every other integration test in this suite.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime, timedelta

import nats
import pytest
from fastapi.testclient import TestClient
from nats.js.api import ConsumerConfig, DeliverPolicy

from app.config import get_settings
from app.events.nats_publisher import ASSIGNMENT_CHANGED_SUBJECT, SCHEDULE_PUBLISHED_SUBJECT
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


def _window(day: date) -> dict[str, str]:
    # Explicit "Z"-suffixed datetimes, not bare dates - same reasoning
    # `test_fairness_ledger_api.py`'s `_shift` helper documents: a naive
    # datetime round-trips through a `timestamptz` comparison ambiguously
    # depending on the DB session's timezone.
    return {
        "from": f"{day.isoformat()}T00:00:00Z",
        "to": f"{(day + timedelta(days=1)).isoformat()}T00:00:00Z",
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
    return client.post(
        f"/v1/scheduling/schedules/{schedule_id}/publish", headers=auth_headers(tenant_id)
    )


async def test_publishing_a_schedule_is_queryable_by_employee_and_publishes_the_event(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=7)
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
        # Subscribing only after entering the TestClient context, since
        # `app/main.py`'s own `lifespan` bootstraps the JetStream stream
        # this subject lives on - see
        # `test_explanation_and_completion_event_api.py`'s identical
        # comment for why `deliver_policy=NEW` matters against a durable,
        # cross-test stream.
        settings = get_settings()
        nc = await nats.connect(settings.nats_url)
        js = nc.jetstream()
        sub = await js.pull_subscribe(
            SCHEDULE_PUBLISHED_SUBJECT,
            durable=f"test-{uuid.uuid4().hex}",
            config=ConsumerConfig(deliver_policy=DeliverPolicy.NEW),
        )

        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        assert schedule["status"] == "draft"

        # Not published yet - the new endpoint returns nothing for a draft.
        empty = client.get(
            f"/v1/scheduling/employees/{employee_id}/shift-assignments",
            params=_window(day),
            headers=auth_headers(tenant_a_id),
        )
        assert empty.status_code == 200, empty.text
        assert empty.json() == []

        publish_response = _publish(client, tenant_a_id, str(schedule["id"]))
        assert publish_response.status_code == 200, publish_response.text

        found = client.get(
            f"/v1/scheduling/employees/{employee_id}/shift-assignments",
            params=_window(day),
            headers=auth_headers(tenant_a_id),
        )
        assert found.status_code == 200, found.text
        results = found.json()
        assert len(results) == 1, results
        assert results[0]["employeeId"] == str(employee_id)
        assert results[0]["scheduleId"] == schedule["id"]
        assert results[0]["publishedAt"] is not None

        messages = await sub.fetch(batch=10, timeout=5)
        await nc.close()

    matching = [json.loads(m.data) for m in messages if json.loads(m.data)["scheduleId"] == schedule["id"]]
    assert len(matching) == 1, f"expected exactly one schedule.published event, got {matching}"
    assert matching[0]["employeeIds"] == [str(employee_id)]


async def test_overriding_an_assignment_publishes_the_assignment_changed_event(
    tenant_a_id: uuid.UUID,
) -> None:
    day = date.today() + timedelta(days=8)
    e1, e2 = _employee(), _employee()
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [e1, e2],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        settings = get_settings()
        nc = await nats.connect(settings.nats_url)
        js = nc.jetstream()
        sub = await js.pull_subscribe(
            ASSIGNMENT_CHANGED_SUBJECT,
            durable=f"test-{uuid.uuid4().hex}",
            config=ConsumerConfig(deliver_policy=DeliverPolicy.NEW),
        )

        job = _submit(client, tenant_a_id, body)
        schedule = _get_schedule(client, tenant_a_id, str(job["id"]))
        assignment = schedule["assignments"][0]

        override_response = client.post(
            f"/v1/scheduling/schedules/{schedule['id']}/assignments/{assignment['id']}/override",
            json={"employeeId": e2["id"]},
            headers=auth_headers(tenant_a_id),
        )
        assert override_response.status_code == 200, override_response.text

        messages = await sub.fetch(batch=10, timeout=5)
        await nc.close()

    matching = [
        json.loads(m.data) for m in messages if json.loads(m.data)["assignmentId"] == assignment["id"]
    ]
    assert len(matching) == 1, f"expected exactly one assignment.changed event, got {matching}"
    assert matching[0]["employeeId"] == e2["id"]
    assert matching[0]["reason"] == "manual_override"


async def test_employee_shift_assignments_are_tenant_isolated(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=9)
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

        cross_tenant = client.get(
            f"/v1/scheduling/employees/{employee_id}/shift-assignments",
            params=_window(day),
            headers=auth_headers(tenant_b_id),
        )
    assert cross_tenant.status_code == 200, cross_tenant.text
    assert cross_tenant.json() == []
