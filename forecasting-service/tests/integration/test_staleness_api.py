"""ADR-0025 Decision 3/4: `GET /v1/forecasting/models/{orgUnitId}/staleness`
against a real Postgres - the three staleness states (no active model,
insufficient accuracy data, and both age/accuracy degradation signals) and
that the endpoint never mutates anything (it's a signal, not a retrain)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastAccuracyLog, ForecastModel, ForecastRun, HistoricalActual
from app.db.session import tenant_scoped_session
from app.main import app
from app.services import training_service
from tests.integration.conftest import FakeTrainingController
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


async def _seed_actuals(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int
) -> None:
    """Same 13-week clean-history seed `test_training_service.py` uses to
    clear the data-quality gate (ADR-0019) - `training_service.retrain`
    trains and promotes nothing at all without it."""
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    as_of = datetime.now(UTC)
    total_intervals = weeks * 7 * 24 * 60 // _INTERVAL_MINUTES
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        for i in range(total_intervals):
            interval_start = as_of - timedelta(minutes=_INTERVAL_MINUTES * (total_intervals - i))
            session.add(
                HistoricalActual(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    org_unit_id=org_unit_id,
                    interval_start=interval_start,
                    actual_volume=10,
                    actual_aht_seconds=300,
                    actual_shrinkage_pct="0.15",
                    created_at=as_of,
                )
            )
        await session.flush()


async def _create_active_model(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> None:
    await _seed_actuals(app_engine, tenant_id, org_unit_id, weeks=13)
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        await training_service.retrain(session, tenant_id=tenant_id, org_unit_id=org_unit_id)


async def _create_forecast_run(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> uuid.UUID:
    """A minimal real `ForecastRun` row - `forecast_accuracy_log` has a real
    FK to `forecast_runs` (`fk_forecast_accuracy_log_tenant_run`), so a
    fabricated random id 400s at insert time rather than silently working."""
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    run_id = uuid.uuid4()
    now = datetime.now(UTC)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        session.add(
            ForecastRun(
                id=run_id,
                tenant_id=tenant_id,
                org_unit_id=org_unit_id,
                date_range_start=now.date(),
                date_range_end=now.date(),
                interval_minutes=_INTERVAL_MINUTES,
                status="completed",
                is_cold_start=False,
                requested_at=now,
                completed_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        await session.flush()
    return run_id


async def _age_the_active_model(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, hours_old: float
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        await session.execute(
            update(ForecastModel)
            .where(
                ForecastModel.tenant_id == tenant_id,
                ForecastModel.org_unit_id == org_unit_id,
                ForecastModel.status == "active",
            )
            .values(trained_at=datetime.now(UTC) - timedelta(hours=hours_old))
        )
        await session.flush()


async def _seed_accuracy_logs(
    app_engine: AsyncEngine,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    *,
    forecast_run_id: uuid.UUID,
    count: int,
    mape: float,
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        now = datetime.now(UTC)
        for i in range(count):
            session.add(
                ForecastAccuracyLog(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    forecast_run_id=forecast_run_id,
                    org_unit_id=org_unit_id,
                    actual_volume=10,
                    predicted_volume=10 + mape / 10,
                    mape=mape,
                    bias=0,
                    evaluated_at=now - timedelta(minutes=i),
                )
            )
        await session.flush()


async def test_no_active_model_reports_insufficient_data_and_no_retrain(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200
    body = response.json()
    assert body["hasActiveModel"] is False
    assert body["insufficientAccuracyData"] is True
    assert body["retrainRecommended"] is False


async def test_a_fresh_active_model_with_no_accuracy_history_is_not_stale(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _create_active_model(app_engine, tenant_a_id, org_unit_id)

    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200
    body = response.json()
    assert body["hasActiveModel"] is True
    assert body["ageStale"] is False
    assert body["insufficientAccuracyData"] is True
    assert body["accuracyDegraded"] is None
    assert body["retrainRecommended"] is False


async def test_a_model_older_than_48_hours_is_age_stale(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _create_active_model(app_engine, tenant_a_id, org_unit_id)
    await _age_the_active_model(app_engine, tenant_a_id, org_unit_id, hours_old=49)

    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200
    body = response.json()
    assert body["ageStale"] is True
    assert body["retrainRecommended"] is True


async def test_accuracy_degraded_beyond_the_relative_margin_recommends_retrain(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    # Fixture default TrainingResult (tests/integration/conftest.py) has
    # backtest_mape=10.0 for any model_type not explicitly pinned.
    fake_ml_backends.set_result("sarima", mape=10.0, wfa=90.0)
    fake_ml_backends.set_result("prophet", mape=12.0, wfa=88.0)
    fake_ml_backends.set_result("lightgbm", mape=13.0, wfa=87.0)
    await _create_active_model(app_engine, tenant_a_id, org_unit_id)
    forecast_run_id = await _create_forecast_run(app_engine, tenant_a_id, org_unit_id)
    # active model's backtest_mape is 10.0 (sarima, lowest) - 50% margin
    # means recent_avg_mape must exceed 15.0 to count as degraded.
    await _seed_accuracy_logs(
        app_engine, tenant_a_id, org_unit_id, forecast_run_id=forecast_run_id, count=10, mape=25.0
    )

    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200
    body = response.json()
    assert body["insufficientAccuracyData"] is False
    assert body["sampleSize"] == 10
    assert body["accuracyDegraded"] is True
    assert body["retrainRecommended"] is True


async def test_staleness_check_never_mutates_the_active_model(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    """ADR-0025 Decision 4: this is a signal, not an automatic retrain -
    calling it repeatedly must not itself change which model is active."""
    org_unit_id = uuid.uuid4()
    await _create_active_model(app_engine, tenant_a_id, org_unit_id)

    with TestClient(app) as client:
        first = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
        second = client.get(
            f"/v1/forecasting/models/{org_unit_id}/staleness", headers=_headers(tenant_a_id)
        )
    assert first.json()["activeModelId"] == second.json()["activeModelId"]
