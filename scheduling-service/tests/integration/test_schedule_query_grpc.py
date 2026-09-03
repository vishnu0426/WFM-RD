"""Module 08 Phase 5 (docs/adr/0103): `list_shift_assignments_for_employees`
(the new bulk query `ScheduleQueryServicer` wraps) and the servicer itself,
called in-process as an async generator - same "no dedicated gRPC-wire test
for a thin servicer wrapper" posture `SchedulingEligibilityServicer` already
established (it has no test of its own either; only the pure/query logic
underneath it is tested here), verified over the real wire during this
phase's own E2E pass instead.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.session import tenant_scoped_session
from app.grpc.generated import schedule_query_pb2
from app.grpc.schedule_query_grpc_server import ScheduleQueryServicer
from app.main import app
from app.services.schedule_service import list_shift_assignments_for_employees
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


def _shift(day: date, start_hour: int, duration_hours: float) -> dict[str, object]:
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    end = start + timedelta(hours=duration_hours)
    return {"id": str(uuid.uuid4()), "start": start.isoformat(), "end": end.isoformat(), "requiredHeadcount": 1}


def _publish_one_shift(client: TestClient, tenant_id: uuid.UUID, day: date, employee_id: uuid.UUID) -> None:
    body = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [{"id": str(employee_id), "contractHoursPerWeek": 40.0}],
        "shiftSlots": [_shift(day, 9, 4)],
    }
    response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
    assert response.status_code == 201, response.text
    job = poll_until_terminal(client, tenant_id, response.json()["jobId"])
    assert job["status"] == "completed", job
    schedule = client.get(
        f"/v1/scheduling/jobs/{job['id']}/schedule", headers=auth_headers(tenant_id)
    ).json()
    publish_response = client.post(
        f"/v1/scheduling/schedules/{schedule['id']}/publish", headers=auth_headers(tenant_id)
    )
    assert publish_response.status_code == 200, publish_response.text


async def test_bulk_query_returns_only_published_assignments_for_the_requested_employees(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=10)
    e1, e2, e3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with TestClient(app) as client:
        _publish_one_shift(client, tenant_a_id, day, e1)
        _publish_one_shift(client, tenant_a_id, day, e2)
        # e3 gets a job that is never published - must not appear below.
        body = {
            "orgUnitId": str(uuid.uuid4()),
            "forecastRunId": str(uuid.uuid4()),
            "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
            "policy": _DEFAULT_POLICY,
            "roster": [{"id": str(e3), "contractHoursPerWeek": 40.0}],
            "shiftSlots": [_shift(day, 9, 4)],
        }
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))
        poll_until_terminal(client, tenant_a_id, response.json()["jobId"])

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        rows = await list_shift_assignments_for_employees(
            session,
            tenant_id=tenant_a_id,
            employee_ids=[e1, e2, e3],
            window_start=datetime(day.year, day.month, day.day, tzinfo=UTC),
            window_end=datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(days=1),
        )

    found_employee_ids = {assignment.employee_id for assignment, _schedule in rows}
    assert found_employee_ids == {e1, e2}


async def test_bulk_query_is_tenant_isolated(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=11)
    employee_id = uuid.uuid4()
    with TestClient(app) as client:
        _publish_one_shift(client, tenant_a_id, day, employee_id)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_b_id)), session_factory=factory
    ) as session:
        rows = await list_shift_assignments_for_employees(
            session,
            tenant_id=tenant_b_id,
            employee_ids=[employee_id],
            window_start=datetime(day.year, day.month, day.day, tzinfo=UTC),
            window_end=datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(days=1),
        )
    assert rows == []


async def test_bulk_query_with_no_employee_ids_returns_empty_without_querying(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        rows = await list_shift_assignments_for_employees(
            session,
            tenant_id=tenant_a_id,
            employee_ids=[],
            window_start=datetime.now(UTC),
            window_end=datetime.now(UTC) + timedelta(days=1),
        )
    assert rows == []


async def test_servicer_streams_one_record_per_published_assignment(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    day = date.today() + timedelta(days=12)
    employee_id = uuid.uuid4()
    with TestClient(app) as client:
        _publish_one_shift(client, tenant_a_id, day, employee_id)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    servicer = ScheduleQueryServicer(session_factory=factory)
    request = schedule_query_pb2.ListPublishedShiftAssignmentsRequest(
        tenant_id=str(tenant_a_id),
        employee_ids=[str(employee_id)],
        window_start=datetime(day.year, day.month, day.day, tzinfo=UTC).isoformat(),
        window_end=(datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(days=1)).isoformat(),
    )
    records = [record async for record in servicer.ListPublishedShiftAssignments(request, object())]
    assert len(records) == 1
    assert records[0].employee_id == str(employee_id)
    assert records[0].schedule_id != ""


async def test_servicer_returns_empty_stream_for_malformed_request(tenant_a_id: uuid.UUID) -> None:
    servicer = ScheduleQueryServicer()
    request = schedule_query_pb2.ListPublishedShiftAssignmentsRequest(
        tenant_id=str(tenant_a_id),
        employee_ids=["not-a-uuid"],
        window_start="not-a-timestamp",
        window_end="not-a-timestamp",
    )
    records = [record async for record in servicer.ListPublishedShiftAssignments(request, object())]
    assert records == []
