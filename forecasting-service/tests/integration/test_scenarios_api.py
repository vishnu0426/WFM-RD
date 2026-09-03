"""§3.3's `POST`/`GET /v1/forecasting/scenarios` (ADR-0024) against the real
FastAPI app, a real Postgres, and a real NATS. Uses a cold-start-completed
run as the scenario's base (Phase 2's synchronous path - no Ray/MLflow
fakes needed to get a real, populated `ForecastRun` to build a scenario
from)."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastDataPoint
from app.db.session import tenant_scoped_session
from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


def _generate_points(weeks: int, *, as_of: datetime) -> list[dict[str, str]]:
    total_intervals = weeks * 7 * 24 * 60 // _INTERVAL_MINUTES
    points: list[dict[str, str]] = []
    for i in range(total_intervals):
        interval_start = as_of - timedelta(minutes=_INTERVAL_MINUTES * (total_intervals - i))
        points.append(
            {
                "intervalStart": interval_start.isoformat(),
                "actualVolume": "10.0",
                "actualAhtSeconds": "300.0",
                "actualShrinkagePct": "0.15",
            }
        )
    return points


def _seed_actuals(client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int) -> None:
    body = {"orgUnitId": str(org_unit_id), "points": _generate_points(weeks, as_of=datetime.now(UTC))}
    response = client.post(
        "/v1/forecasting/actuals", json=body, headers=auth_headers(tenant_id)
    )
    assert response.status_code == 200, response.text


def _seed_queue_profile(client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID) -> None:
    body = {
        "industry": "retail",
        "queueType": "inbound_support",
        "expectedVolumeBand": "m",
        "timezoneBucket": "utc-5",
    }
    response = client.put(
        f"/v1/forecasting/queue-profiles/{org_unit_id}", json=body, headers=auth_headers(tenant_id)
    )
    assert response.status_code == 200, response.text


def _date_range(*, start_offset_days: int, span_days: int) -> tuple[str, str]:
    start = date.today() + timedelta(days=start_offset_days)
    end = start + timedelta(days=span_days)
    return start.isoformat(), end.isoformat()


async def _get_data_points(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, forecast_run_id: uuid.UUID
) -> list[ForecastDataPoint]:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        return list(
            (
                await session.scalars(
                    select(ForecastDataPoint).where(
                        ForecastDataPoint.tenant_id == tenant_id,
                        ForecastDataPoint.forecast_run_id == forecast_run_id,
                    )
                )
            ).all()
        )


def _create_cold_start_base_run(client: TestClient, tenant_id: uuid.UUID) -> str:
    """Returns a `jobId` for a cold-start-completed run - real
    `ForecastDataPoint` rows, no Ray/MLflow involved."""
    target_org_unit_id = uuid.uuid4()
    donor_org_unit_id = uuid.uuid4()
    _seed_queue_profile(client, tenant_id, target_org_unit_id)
    _seed_queue_profile(client, tenant_id, donor_org_unit_id)
    _seed_actuals(client, tenant_id, donor_org_unit_id, weeks=3)

    start, end = _date_range(start_offset_days=1, span_days=6)
    response = client.post(
        "/v1/forecasting/jobs",
        json={
            "orgUnitId": str(target_org_unit_id),
            "dateRange": {"start": start, "end": end},
            "intervalMinutes": _INTERVAL_MINUTES,
        },
        headers={**_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "completed"
    return str(body["jobId"])


async def test_create_scenario_with_volume_multiplier_scales_volume_and_headcount(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    with TestClient(app) as client:
        base_job_id = _create_cold_start_base_run(client, tenant_a_id)

        response = client.post(
            "/v1/forecasting/scenarios",
            json={
                "baseForecastRunId": base_job_id,
                "assumptionOverrides": {"volumeMultiplier": "2.0"},
            },
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["resultForecastRunId"] is not None
    assert body["baseForecastRunId"] == base_job_id

    base_points = await _get_data_points(app_engine, tenant_a_id, uuid.UUID(base_job_id))
    result_points = await _get_data_points(
        app_engine, tenant_a_id, uuid.UUID(body["resultForecastRunId"])
    )
    assert len(result_points) == len(base_points)

    base_by_interval = {p.interval_start: p for p in base_points}
    for result_point in result_points:
        base_point = base_by_interval[result_point.interval_start]
        if base_point.predicted_volume is not None:
            assert result_point.predicted_volume is not None
            assert float(result_point.predicted_volume) == pytest.approx(
                float(base_point.predicted_volume) * 2.0, rel=1e-6
            )
        # Doubling volume should never *decrease* required headcount.
        if base_point.required_headcount is not None and result_point.required_headcount is not None:
            assert float(result_point.required_headcount) >= float(base_point.required_headcount)


async def test_get_scenario_returns_the_created_scenario(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        base_job_id = _create_cold_start_base_run(client, tenant_a_id)
        create_response = client.post(
            "/v1/forecasting/scenarios",
            json={"baseForecastRunId": base_job_id, "assumptionOverrides": {}},
            headers=_headers(tenant_a_id),
        )
        scenario_id = create_response.json()["id"]

        get_response = client.get(
            f"/v1/forecasting/scenarios/{scenario_id}", headers=_headers(tenant_a_id)
        )
    assert get_response.status_code == 200
    assert get_response.json()["id"] == scenario_id
    assert get_response.json()["status"] == "completed"


async def test_create_scenario_for_nonexistent_base_run_returns_404(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/forecasting/scenarios",
            json={"baseForecastRunId": str(uuid.uuid4()), "assumptionOverrides": {}},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_create_scenario_for_a_run_with_no_data_points_returns_422(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=27)
    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=9)
        job_response = client.post(
            "/v1/forecasting/jobs",
            json={
                "orgUnitId": str(org_unit_id),
                "dateRange": {"start": start, "end": end},
                "intervalMinutes": _INTERVAL_MINUTES,
            },
            headers={**_headers(tenant_a_id), "Idempotency-Key": str(uuid.uuid4())},
        )
        assert job_response.status_code == 201
        assert job_response.json()["status"] == "queued"  # sufficient history, but no active model yet

        response = client.post(
            "/v1/forecasting/scenarios",
            json={"baseForecastRunId": job_response.json()["jobId"], "assumptionOverrides": {}},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCENARIO_BASE_RUN_EMPTY"


async def test_a_tenant_cannot_use_another_tenants_run_as_a_scenario_base(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    with TestClient(app) as client:
        base_job_id = _create_cold_start_base_run(client, tenant_a_id)
        response = client.post(
            "/v1/forecasting/scenarios",
            json={"baseForecastRunId": base_job_id, "assumptionOverrides": {}},
            headers=_headers(tenant_b_id),
        )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
