"""Module 10 Phase 2 (docs/adr/0115): `ScheduleExplanationDataServicer` -
the read half of the Module 04<->Module 10 schedule-explanation handoff.
Same "no dedicated gRPC-wire test for a thin servicer wrapper" posture
`ScheduleQueryServicer`/`SchedulingEligibilityServicer` already established -
called in-process, verified over the real wire during E2E passes instead.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.grpc.generated import schedule_explanation_data_pb2
from app.grpc.schedule_explanation_data_grpc_server import ScheduleExplanationDataServicer
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


def _submit_and_complete_job(client: TestClient, tenant_id: uuid.UUID, day: date) -> str:
    employee_id = uuid.uuid4()
    start = f"{day.isoformat()}T09:00:00Z"
    end = f"{day.isoformat()}T13:00:00Z"
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [{"id": str(employee_id), "contractHoursPerWeek": 40.0}],
        "shiftSlots": [{"id": str(uuid.uuid4()), "start": start, "end": end, "requiredHeadcount": 1}],
    }
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job = poll_until_terminal(client, tenant_id, response.json()["jobId"])
    assert job["status"] == "completed", job
    return str(job["id"])


async def test_servicer_returns_solve_data_for_a_completed_job(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=20)
    with TestClient(app) as client:
        job_id = _submit_and_complete_job(client, tenant_a_id, day)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    servicer = ScheduleExplanationDataServicer(session_factory=factory)
    request = schedule_explanation_data_pb2.GetScheduleJobForExplanationRequest(
        tenant_id=str(tenant_a_id), job_id=job_id
    )
    response = await servicer.GetScheduleJobForExplanation(request, object())

    assert response.found is True
    assert response.tenant_id == str(tenant_a_id)
    assert response.status == "completed"
    assert response.completed_at != ""
    assert response.date_range_start == day.isoformat()
    # constraint_config_json is always valid JSON, even the "{}" default.
    json.loads(response.constraint_config_json)


async def test_servicer_returns_not_found_for_wrong_tenant(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=21)
    with TestClient(app) as client:
        job_id = _submit_and_complete_job(client, tenant_a_id, day)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    servicer = ScheduleExplanationDataServicer(session_factory=factory)
    request = schedule_explanation_data_pb2.GetScheduleJobForExplanationRequest(
        tenant_id=str(tenant_b_id), job_id=job_id
    )
    response = await servicer.GetScheduleJobForExplanation(request, object())

    assert response.found is False


async def test_servicer_returns_not_found_for_malformed_ids(tenant_a_id: uuid.UUID) -> None:
    servicer = ScheduleExplanationDataServicer()
    request = schedule_explanation_data_pb2.GetScheduleJobForExplanationRequest(
        tenant_id=str(tenant_a_id), job_id="not-a-uuid"
    )
    response = await servicer.GetScheduleJobForExplanation(request, object())

    assert response.found is False
