"""ADR-0026, Decision 1/5 - `tft` is only ever attempted when explicitly
requested via `RetrainRequest.modelTypes`, and requesting it without
`TenantSettings.tft_entitled` set is a hard 403
(`TftEntitlementMissingError`), checked *before* the data-quality gate -
against a real Postgres, with `ray_orchestrator`/`mlflow_registry` faked
(`fake_ml_backends`) to keep this fast (real TFT training is exercised for
real in `tests/unit/test_tft.py`, not re-verified here)."""

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


def _headers(tenant_id: uuid.UUID, *, is_admin: bool = False) -> dict[str, str]:
    # GAP-08 fix (enterprise readiness audit, 2026-08-18): platform-admin
    # status is a verified JWT claim now, not a raw `X-Platform-Admin`
    # header - see test_admin_api.py's identical fix.
    return auth_headers(tenant_id, is_platform_admin=is_admin)


def _grant_tft_entitlement(client: TestClient, tenant_id: uuid.UUID) -> None:
    response = client.put(
        "/v1/forecasting/admin/tenant-settings",
        json={"tftEntitled": True},
        headers=_headers(tenant_id, is_admin=True),
    )
    assert response.status_code == 200, response.text


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


async def test_requesting_tft_without_entitlement_is_a_403(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=27)

    with TestClient(app) as client:
        response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["tft"]},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "TFT_ENTITLEMENT_MISSING"


async def test_requesting_tft_without_entitlement_never_touches_the_data_quality_gate(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    """No `historical_actuals` seeded at all - if the entitlement check ran
    *after* the gate, this would 422 with `insufficient_history` instead of
    403; asserting 403 here is what proves the ordering (ADR-0026,
    Decision 5 / ADR-0019's "checked before a `tft` training job is queued
    at all")."""
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["tft"]},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "TFT_ENTITLEMENT_MISSING"


async def test_omitting_model_types_never_attempts_tft_regardless_of_entitlement(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=27)

    with TestClient(app) as client:
        response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 200, response.text
    model_types = {outcome["modelType"] for outcome in response.json()["outcomes"]}
    assert model_types == {"sarima", "prophet", "lightgbm"}


async def test_an_entitled_tenant_can_train_tft(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=27)
    fake_ml_backends.set_result("tft", mape=7.0, wfa=93.0)

    with TestClient(app) as client:
        _grant_tft_entitlement(client, tenant_a_id)
        response = client.post(
            f"/v1/forecasting/models/{org_unit_id}/retrain",
            json={"modelTypes": ["sarima", "tft"]},
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 200, response.text
    by_type = {o["modelType"]: o for o in response.json()["outcomes"]}
    assert set(by_type) == {"sarima", "tft"}
    assert by_type["tft"]["trained"] is True
    assert by_type["tft"]["status"] == "active"  # lowest mape (7.0), no active model to beat
