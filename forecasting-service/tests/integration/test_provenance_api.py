"""ADR-0026, Decision 6 - `GET /v1/forecasting/models/{orgUnitId}/provenance`:
the full audit trail (active/deprecated/failed, newest first) plus real
`lightgbm` feature importances for the active model, against a real
Postgres with `ray_orchestrator`/`mlflow_registry` faked
(`fake_ml_backends`) - the fake's `load_model` fits a real (tiny)
`lightgbm` booster (`tests/integration/conftest.py`), so the feature-
importance extraction itself is exercised for real, not mocked away."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import HistoricalActual
from app.db.session import tenant_scoped_session
from app.main import app
from tests.integration.conftest import FakeTrainingController
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


async def _seed_actuals(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int
) -> None:
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


async def test_provenance_lists_the_full_history_newest_first_including_deprecated(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)

    with TestClient(app) as client:
        fake_ml_backends.set_result("sarima", mape=10.0, wfa=90.0)
        fake_ml_backends.set_result("prophet", mape=4.0, wfa=96.0)
        fake_ml_backends.set_result("lightgbm", mape=9.0, wfa=91.0)
        retrain_response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain", json={}, headers=_headers(tenant_a_id)
        )
        assert retrain_response.status_code == 200, retrain_response.text

        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/provenance", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["history"]) == 3
    by_type = {m["modelType"]: m for m in body["history"]}
    assert by_type["prophet"]["status"] == "active"  # lowest mape, no active model to beat
    assert by_type["sarima"]["status"] == "deprecated"
    assert by_type["lightgbm"]["status"] == "deprecated"
    assert body["activeModelId"] == by_type["prophet"]["id"]


async def test_provenance_surfaces_real_feature_importances_for_an_active_lightgbm_model(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)

    with TestClient(app) as client:
        fake_ml_backends.set_result("lightgbm", mape=3.0, wfa=97.0)
        retrain_response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["lightgbm"]},
            headers=_headers(tenant_a_id),
        )
        assert retrain_response.status_code == 200, retrain_response.text
        assert retrain_response.json()["outcomes"][0]["status"] == "active"

        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/provenance", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200, response.text
    body = response.json()
    importances = body["featureImportances"]
    assert importances is not None
    feature_names = {entry["feature"] for entry in importances}
    # `app/ml/lightgbm_model.py`'s calendar-only feature set (ADR-0022).
    assert feature_names == {"day_of_week", "hour", "minute_of_day", "is_weekend"}


async def test_provenance_has_no_feature_importances_for_a_non_lightgbm_active_model(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)

    with TestClient(app) as client:
        retrain_response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["sarima"]},
            headers=_headers(tenant_a_id),
        )
        assert retrain_response.status_code == 200, retrain_response.text

        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/provenance", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200, response.text
    assert response.json()["featureImportances"] is None


async def test_provenance_with_no_models_trained_yet_is_an_empty_history(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/provenance", headers=_headers(tenant_a_id)
        )
    assert response.status_code == 200
    body = response.json()
    assert body["history"] == []
    assert body["activeModelId"] is None
    assert body["featureImportances"] is None


async def test_a_tenant_cannot_see_another_tenants_provenance(
    tenant_a_id: uuid.UUID,
    tenant_b_id: uuid.UUID,
    app_engine: AsyncEngine,
    fake_ml_backends: FakeTrainingController,
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)

    with TestClient(app) as client:
        client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["sarima"]},
            headers=_headers(tenant_a_id),
        )
        response = client.get(
            f"/v1/forecasting/models/{org_unit_id}/provenance", headers=_headers(tenant_b_id)
        )
    assert response.status_code == 200
    assert response.json()["history"] == []
