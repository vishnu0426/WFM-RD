"""§3.3's `POST /v1/forecasting/models/{orgUnitId}/retrain` and
`GET /v1/forecasting/models/{orgUnitId}` over HTTP, plus the job-fulfillment
path they unlock: once a model is `active`, `POST /v1/forecasting/jobs`
should complete synchronously using it (ADR-0021, Decision 2) instead of
sitting at `queued`. `ray_orchestrator`/`mlflow_registry` are faked
(`fake_ml_backends`) for the same reason `test_training_service.py` fakes
them.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastDataPoint
from app.db.session import tenant_scoped_session
from app.main import app
from tests.integration.conftest import FakeTrainingController
from tests.jwt_test_helpers import auth_headers

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
    response = client.post("/v1/forecasting/actuals", json=body, headers=_headers(tenant_id))
    assert response.status_code == 200, response.text


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


def test_retrain_then_list_models_reflects_the_promotion_decision(
    tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    fake_ml_backends.set_result("sarima", mape=9.0, wfa=91.0)
    fake_ml_backends.set_result("prophet", mape=2.0, wfa=98.0)
    fake_ml_backends.set_result("lightgbm", mape=7.0, wfa=93.0)

    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=13)

        retrain_response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain", json={}, headers=_headers(tenant_a_id)
        )
        assert retrain_response.status_code == 200, retrain_response.text
        outcomes = {o["modelType"]: o for o in retrain_response.json()["outcomes"]}
        assert outcomes["prophet"]["status"] == "active"
        assert outcomes["sarima"]["status"] == "deprecated"
        assert outcomes["lightgbm"]["status"] == "deprecated"

        list_response = client.get(f"/v1/forecasting/models/{org_unit_id}", headers=_headers(tenant_a_id))
        assert list_response.status_code == 200
        models = list_response.json()
        assert {m["modelType"] for m in models} == {"sarima", "prophet", "lightgbm"}
        active = [m for m in models if m["status"] == "active"]
        assert len(active) == 1
        assert active[0]["modelType"] == "prophet"


def test_retrain_with_no_history_reports_failure_reasons_without_training(
    tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain", json={}, headers=_headers(tenant_a_id)
        )

    assert response.status_code == 200
    outcomes = response.json()["outcomes"]
    assert all(o["trained"] is False for o in outcomes)
    assert all(o["reason"] == "insufficient_history" for o in outcomes)


async def test_job_submission_is_fulfilled_synchronously_once_a_model_is_active(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    fake_ml_backends.set_result("sarima", mape=5.0, wfa=95.0)
    fake_ml_backends.set_result("prophet", mape=6.0, wfa=94.0)
    fake_ml_backends.set_result("lightgbm", mape=7.0, wfa=93.0)

    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=13)
        retrain_response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain", json={}, headers=_headers(tenant_a_id)
        )
        assert retrain_response.status_code == 200

        # Relative to today, not a hardcoded literal - see
        # test_jobs_api.py's `_date_range` docstring for why.
        start = date.today() + timedelta(days=1)
        end = start + timedelta(days=6)
        job_response = client.post(
            "/v1/forecasting/jobs",
            json={
                "orgUnitId": str(org_unit_id),
                "dateRange": {"start": start.isoformat(), "end": end.isoformat()},
                "intervalMinutes": _INTERVAL_MINUTES,
            },
            headers={**_headers(tenant_a_id), "Idempotency-Key": str(uuid.uuid4())},
        )
        assert job_response.status_code == 201, job_response.text
        job_body = job_response.json()
        assert job_body["status"] == "completed"

        run_response = client.get(
            f"/v1/forecasting/jobs/{job_body['jobId']}", headers=_headers(tenant_a_id)
        )
    run = run_response.json()
    assert run["status"] == "completed"
    assert run["isColdStart"] is False
    assert run["forecastModelId"] is not None

    # Phase 5 (ADR-0023): predicted_aht_seconds is NULL on a model-fulfilled
    # run (ADR-0020/0021's target_metric='volume'-only convention), so
    # required_headcount here only exists because of the historical-average
    # AHT/shrinkage fallback chain - not left NULL just because the model
    # itself never forecasts AHT.
    points = await _get_data_points(app_engine, tenant_a_id, uuid.UUID(job_body["jobId"]))
    assert len(points) > 0
    assert any(point.required_headcount is not None for point in points)
