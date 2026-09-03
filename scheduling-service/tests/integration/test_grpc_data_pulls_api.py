"""Phase 6/ADR-0059's end-to-end proof: a job submission that omits
`roster`/`policy`/a shift's `requiredHeadcount` is filled in for real from
Module 01/02's actual running gRPC server (`EmployeeService`/
`PolicyService`) and Module 03's actual running `ForecastService` - not
stubs, not a second fake implementation of either contract.

Requires, reachable at the URLs below (see the Phase 6 design doc's
"Getting started" section for how these were booted for real in this
session):
- The real Module 01/02 app (`npm run start:dev` from the repo root),
  gRPC on `CORE_GRPC_URL` (this suite defaults to `localhost:5001` - macOS's
  AirPlay Receiver squats on the documented default `:5000`).
- A real `forecasting-service` `ForecastService` gRPC server (this session:
  `python run_grpc_server_standalone.py`, not the full `app.main` - see
  that file's own note about why), on `FORECASTING_GRPC_URL`
  (`localhost:6000`).
- Module 01/02's migrations applied (`npm run migration:run` from the repo
  root) and forecasting-service's migrations applied (`alembic upgrade
  head` from `forecasting-service/`).

Phase 7 (ADR-0060): the gRPC pulls happen worker-side now - every test here
polls to terminal (`poll_until_terminal`, conftest.py) rather than asserting
the `POST` response's own `status` directly.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import asyncpg
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from tests.jwt_test_helpers import auth_headers

os.environ.setdefault("CORE_GRPC_URL", "localhost:5001")
os.environ.setdefault("FORECASTING_GRPC_URL", "localhost:6000")

from app.main import app  # noqa: E402 - must follow the env var defaults above

from .conftest import poll_until_terminal  # noqa: E402 - must follow the env var defaults above

pytestmark = pytest.mark.asyncio

_DEFAULT_POLICY = {
    "maxConsecutiveWorkingDays": 5,
    "minRestHoursBetweenShifts": 10.0,
    "minShiftLengthMinutes": 240,
    "maxShiftLengthMinutes": 600,
}


def _core_migrator_dsn() -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5433")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv("DB_MIGRATION_PASSWORD", "changeme_local_only")
    return f"postgresql://agno_migrator:{password}@{host}:{port}/{database}"


def _forecasting_migrator_dsn() -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5433")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv("DB_MIGRATION_PASSWORD", "changeme_local_only")
    return f"postgresql://agno_migrator:{password}@{host}:{port}/{database}"


@pytest_asyncio.fixture
async def core_conn():
    conn = await asyncpg.connect(_core_migrator_dsn())
    yield conn
    await conn.close()


@pytest_asyncio.fixture
async def forecasting_conn():
    conn = await asyncpg.connect(_forecasting_migrator_dsn())
    yield conn
    await conn.close()


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


async def _seed_tenant_and_org_unit(core_conn, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID) -> None:
    await core_conn.execute(
        "INSERT INTO core.tenants (id, name, tier, data_residency_region, status) "
        "VALUES ($1, $2, 'enterprise', 'us', 'active')",
        tenant_id,
        f"phase6-test-{tenant_id}",
    )
    await core_conn.execute(
        "INSERT INTO org.org_units (id, tenant_id, type, name, timezone, country_code) "
        "VALUES ($1, $2, 'site', 'Test Site', 'UTC', 'US')",
        org_unit_id,
        tenant_id,
    )


async def _seed_employee(
    core_conn,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    employee_id: uuid.UUID,
    employee_number: str,
    contract_hours: float,
    skill_id: uuid.UUID | None = None,
) -> None:
    await core_conn.execute(
        "INSERT INTO org.employees "
        "(tenant_id, id, org_unit_id, employee_number, employment_type, contract_hours_per_week, "
        "hire_date, status) "
        "VALUES ($1, $2, $3, $4, 'full_time', $5, $6, 'active')",
        tenant_id,
        employee_id,
        org_unit_id,
        employee_number,
        Decimal(str(contract_hours)),
        date.today() - timedelta(days=365),
    )
    if skill_id is not None:
        await core_conn.execute(
            "INSERT INTO org.employee_skills "
            "(tenant_id, employee_id, skill_id, proficiency_level, decay_score, updated_at) "
            "VALUES ($1, $2, $3, 'expert', 0.1, now())",
            tenant_id,
            employee_id,
            skill_id,
        )


async def _seed_employment_policy(
    core_conn, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, policy_type: str, definition: dict
) -> None:
    await core_conn.execute(
        "INSERT INTO core.policies "
        "(id, tenant_id, policy_group_id, policy_type, definition, effective_from, version, org_unit_id) "
        "VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', 1, $6)",
        uuid.uuid4(),
        tenant_id,
        uuid.uuid4(),
        policy_type,
        json.dumps(definition),
        org_unit_id,
    )


async def _seed_forecast_run_and_points(
    forecasting_conn, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, points: list[tuple[datetime, str]]
) -> uuid.UUID:
    run_id = uuid.uuid4()
    now = datetime.now(UTC)
    await forecasting_conn.execute(
        "INSERT INTO forecasting.forecast_runs "
        "(id, tenant_id, org_unit_id, date_range_start, date_range_end, interval_minutes, status, "
        "is_cold_start, requested_at, completed_at, created_at, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, 30, 'completed', false, $6, $6, $6, $6)",
        run_id,
        tenant_id,
        org_unit_id,
        date.today(),
        date.today() + timedelta(days=1),
        now,
    )
    for interval_start, required_headcount in points:
        await forecasting_conn.execute(
            "INSERT INTO forecasting.forecast_data_points "
            "(id, tenant_id, forecast_run_id, interval_start, required_headcount, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            uuid.uuid4(),
            tenant_id,
            run_id,
            interval_start,
            Decimal(required_headcount),
            now,
        )
    return run_id


async def test_omitted_roster_and_policy_are_pulled_via_grpc_and_solved(core_conn) -> None:
    tenant_id = uuid.uuid4()
    org_unit_id = uuid.uuid4()
    employee_id = uuid.uuid4()
    day = date.today() + timedelta(days=30)

    await _seed_tenant_and_org_unit(core_conn, tenant_id=tenant_id, org_unit_id=org_unit_id)
    await _seed_employee(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        employee_id=employee_id,
        employee_number="E-001",
        contract_hours=40.0,
    )
    await _seed_employment_policy(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        policy_type="rest_period_minimum",
        definition={"minRestHoursBetweenShifts": 11.0},
    )
    await _seed_employment_policy(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        policy_type="max_consecutive_days",
        definition={"maxConsecutiveWorkingDays": 4},
    )
    await _seed_employment_policy(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        policy_type="union_rule",
        definition={"minShiftLengthMinutes": 120, "maxShiftLengthMinutes": 720},
    )

    shift_start = datetime(day.year, day.month, day.day, 9, tzinfo=UTC)
    shift_end = shift_start + timedelta(hours=8)
    body = {
        "orgUnitId": str(org_unit_id),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        # policy and roster both omitted entirely - must be pulled.
        "shiftSlots": [
            {
                "id": str(uuid.uuid4()),
                "start": shift_start.isoformat(),
                "end": shift_end.isoformat(),
                "requiredHeadcount": 1,
            }
        ],
    }
    with TestClient(app) as client:
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
        assert response.status_code == 201, response.text
        job_id = response.json()["jobId"]
        job = poll_until_terminal(client, tenant_id, job_id)
        assert job["status"] == "completed", job

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job['id']}/schedule", headers=auth_headers(tenant_id)
        )

    assert schedule_response.status_code == 200, schedule_response.text
    assignments = schedule_response.json()["assignments"]
    assert len(assignments) == 1
    # The only employee that could have been assigned is the one seeded
    # directly into Module 02's own database - proof the roster was pulled
    # via the real EmployeeService, not defaulted/invented.
    assert assignments[0]["employeeId"] == str(employee_id)


async def test_omitted_shift_headcount_is_derived_from_the_forecast_pull(
    core_conn, forecasting_conn
) -> None:
    tenant_id = uuid.uuid4()
    org_unit_id = uuid.uuid4()
    e1, e2 = uuid.uuid4(), uuid.uuid4()
    day = date.today() + timedelta(days=30)

    await _seed_tenant_and_org_unit(core_conn, tenant_id=tenant_id, org_unit_id=org_unit_id)
    await _seed_employee(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        employee_id=e1,
        employee_number="E-101",
        contract_hours=40.0,
    )
    await _seed_employee(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        employee_id=e2,
        employee_number="E-102",
        contract_hours=40.0,
    )

    shift_start = datetime(day.year, day.month, day.day, 9, tzinfo=UTC)
    shift_end = shift_start + timedelta(hours=4)
    forecast_run_id = await _seed_forecast_run_and_points(
        forecasting_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        points=[
            (shift_start, "1.00"),
            (shift_start + timedelta(minutes=30), "2.00"),  # the peak - shift must staff for this
            (shift_start + timedelta(hours=1), "1.00"),
        ],
    )

    body = {
        "orgUnitId": str(org_unit_id),
        "forecastRunId": str(forecast_run_id),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [
            {"id": str(e1), "contractHoursPerWeek": 40.0},
            {"id": str(e2), "contractHoursPerWeek": 40.0},
        ],
        "shiftSlots": [
            {
                "id": str(uuid.uuid4()),
                "start": shift_start.isoformat(),
                "end": shift_end.isoformat(),
                # requiredHeadcount omitted entirely - must be derived.
            }
        ],
    }
    with TestClient(app) as client:
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
        assert response.status_code == 201, response.text
        job_id = response.json()["jobId"]
        job = poll_until_terminal(client, tenant_id, job_id)
        assert job["status"] == "completed", job

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job['id']}/schedule", headers=auth_headers(tenant_id)
        )

    assignments = schedule_response.json()["assignments"]
    # Peak interval required 2 - both employees must be assigned, proving
    # the derived headcount was 2, not 1 (the first interval) or unset.
    assert len(assignments) == 2


async def test_explicit_roster_and_policy_win_over_the_pull(core_conn) -> None:
    """An explicitly-supplied roster/policy is used as-is - never merged
    with, or silently replaced by, a gRPC pull (ADR-0059 Decision 2)."""
    tenant_id = uuid.uuid4()
    org_unit_id = uuid.uuid4()
    # Deliberately seed a *different* employee in Module 02's DB than the
    # one the request supplies - if the pull fired anyway, this employee
    # would show up in the assignment instead.
    decoy_employee_id = uuid.uuid4()
    explicit_employee_id = uuid.uuid4()
    day = date.today() + timedelta(days=30)

    await _seed_tenant_and_org_unit(core_conn, tenant_id=tenant_id, org_unit_id=org_unit_id)
    await _seed_employee(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        employee_id=decoy_employee_id,
        employee_number="E-DECOY",
        contract_hours=40.0,
    )

    shift_start = datetime(day.year, day.month, day.day, 9, tzinfo=UTC)
    shift_end = shift_start + timedelta(hours=4)
    body = {
        "orgUnitId": str(org_unit_id),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [{"id": str(explicit_employee_id), "contractHoursPerWeek": 40.0}],
        "shiftSlots": [
            {
                "id": str(uuid.uuid4()),
                "start": shift_start.isoformat(),
                "end": shift_end.isoformat(),
                "requiredHeadcount": 1,
            }
        ],
    }
    with TestClient(app) as client:
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
        assert response.status_code == 201, response.text
        job_id = response.json()["jobId"]
        job = poll_until_terminal(client, tenant_id, job_id)
        assert job["status"] == "completed", job

        schedule_response = client.get(
            f"/v1/scheduling/jobs/{job['id']}/schedule", headers=auth_headers(tenant_id)
        )

    assignments = schedule_response.json()["assignments"]
    assert len(assignments) == 1
    assert assignments[0]["employeeId"] == str(explicit_employee_id)


async def test_omitted_shift_headcount_with_a_nonexistent_forecast_run_is_rejected_async(core_conn) -> None:
    tenant_id = uuid.uuid4()
    org_unit_id = uuid.uuid4()
    employee_id = uuid.uuid4()
    day = date.today() + timedelta(days=30)

    await _seed_tenant_and_org_unit(core_conn, tenant_id=tenant_id, org_unit_id=org_unit_id)
    await _seed_employee(
        core_conn,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        employee_id=employee_id,
        employee_number="E-201",
        contract_hours=40.0,
    )

    shift_start = datetime(day.year, day.month, day.day, 9, tzinfo=UTC)
    shift_end = shift_start + timedelta(hours=4)
    body = {
        "orgUnitId": str(org_unit_id),
        "forecastRunId": str(uuid.uuid4()),  # never seeded anywhere
        "dateRange": {"start": day.isoformat(), "end": day.isoformat()},
        "policy": _DEFAULT_POLICY,
        "roster": [{"id": str(employee_id), "contractHoursPerWeek": 40.0}],
        "shiftSlots": [
            {"id": str(uuid.uuid4()), "start": shift_start.isoformat(), "end": shift_end.isoformat()}
        ],
    }
    with TestClient(app) as client:
        # Phase 7 (ADR-0060 Decision 5): this used to be a synchronous 422 -
        # the forecast pull now happens worker-side, so the enqueue itself
        # succeeds and the failure only surfaces once the job resolves.
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_id))
        assert response.status_code == 201, response.text
        job_id = response.json()["jobId"]
        job = poll_until_terminal(client, tenant_id, job_id)

    assert job["status"] == "failed", job
    assert job["relaxationsApplied"]["failureReason"]["code"] == "SHIFT_HEADCOUNT_UNDETERMINED"
