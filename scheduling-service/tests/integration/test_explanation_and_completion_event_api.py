"""Phase 6's two remaining pieces: `job_service` actually publishing
`agno.scheduling.job.completed.v1` on every terminal solve outcome (wiring
`app/events/nats_publisher.py`'s previously-built-but-never-called
publisher into a real trigger for the first time), and the
`ScheduleExplanation` write-back/read-surface Module 10's handoff uses.
Against a real FastAPI app, a real Postgres, and a real NATS+JetStream
broker.

Phase 7 (ADR-0060): submission only enqueues now, but nothing in this file
needed a `poll_until_terminal` rewrite - the completion-event test already
waits on the NATS message itself (a real, if indirect, wait for the worker
to finish), and the explanation endpoints never gate on job status (Module
10 calls back after `agno.scheduling.job.completed.v1`, but
`explanation_service.submit_explanation` only requires the job to exist).
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
from app.events.nats_publisher import JOB_COMPLETED_SUBJECT
from app.main import app
from tests.jwt_test_helpers import auth_headers

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


def _employee() -> dict[str, object]:
    return {"id": str(uuid.uuid4()), "contractHoursPerWeek": 40.0}


async def test_submitting_a_job_publishes_the_completion_event(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=5)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        # Subscribing only after entering the TestClient context, since
        # `app/main.py`'s own `lifespan` is what bootstraps the JetStream
        # stream this subject lives on (`nats_publisher.bootstrap_stream`) -
        # subscribing any earlier would race a stream that doesn't exist yet.
        # `deliver_policy=NEW`: this stream is real and durable across every
        # test run in this session (and every other job-submitting test in
        # this same suite) - without it, a fresh consumer starts from the
        # stream's oldest retained message, and `batch=10` would exhaust on
        # old backlog before ever reaching the message this test just
        # published.
        settings = get_settings()
        nc = await nats.connect(settings.nats_url)
        js = nc.jetstream()
        sub = await js.pull_subscribe(
            JOB_COMPLETED_SUBJECT,
            durable=f"test-{uuid.uuid4().hex}",
            config=ConsumerConfig(deliver_policy=DeliverPolicy.NEW),
        )

        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        assert response.status_code == 201, response.text
        job_id = response.json()["jobId"]

        messages = await sub.fetch(batch=10, timeout=5)
        await nc.close()

    matching = [json.loads(m.data) for m in messages if json.loads(m.data)["scheduleJobId"] == job_id]
    assert len(matching) == 1, f"expected exactly one completion event for {job_id}, got {matching}"
    assert matching[0]["status"] == "completed"
    assert matching[0]["tenantId"] == str(tenant_a_id)


async def test_submitting_an_explanation_and_reading_it_back(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=5)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        job_id = submit_response.json()["jobId"]

        # Before Module 10 ever calls back, GET reflects no explanation.
        before = client.get(f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_a_id))
        assert before.json()["explanation"] is None

        model_id = str(uuid.uuid4())
        explanation_response = client.post(
            f"/v1/scheduling/jobs/{job_id}/explanation",
            json={
                "summaryText": "One employee covers the single 4-hour shift within contracted hours.",
                "topConstraints": {"coverage": "binding"},
                "tradeOffs": {"overtimeHours": 0},
                "generatedByModelId": model_id,
            },
            headers=auth_headers(tenant_a_id),
        )
        assert explanation_response.status_code == 200, explanation_response.text
        assert explanation_response.json()["explanation"]["summaryText"].startswith("One employee")

        after = client.get(f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_a_id))

    explanation = after.json()["explanation"]
    assert explanation is not None
    assert explanation["generatedByModelId"] == model_id
    assert explanation["topConstraints"] == {"coverage": "binding"}


async def test_resubmitting_an_explanation_upserts_rather_than_duplicates(tenant_a_id: uuid.UUID) -> None:
    day = date.today() + timedelta(days=5)
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [_employee()],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    with TestClient(app) as client:
        submit_response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        job_id = submit_response.json()["jobId"]

        first = client.post(
            f"/v1/scheduling/jobs/{job_id}/explanation",
            json={"summaryText": "first draft"},
            headers=auth_headers(tenant_a_id),
        )
        second = client.post(
            f"/v1/scheduling/jobs/{job_id}/explanation",
            json={"summaryText": "regenerated"},
            headers=auth_headers(tenant_a_id),
        )

    assert first.json()["explanation"]["id"] == second.json()["explanation"]["id"]
    assert second.json()["explanation"]["summaryText"] == "regenerated"


async def test_submitting_an_explanation_for_a_nonexistent_job_404s(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.post(
            f"/v1/scheduling/jobs/{uuid.uuid4()}/explanation",
            json={"summaryText": "orphaned"},
            headers=auth_headers(tenant_a_id),
        )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
