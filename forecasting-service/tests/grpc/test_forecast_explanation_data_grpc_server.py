"""Module 10 Phase 4 (docs/adr/0119): `ForecastExplanationDataService`.
Same posture as `test_forecast_grpc_server.py` - a real `grpc.aio.Server`
bound to a real socket and a real Postgres, deliberately outside
`tests/integration/` (whose `conftest.py` transitively imports this
service's full ML stack).
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import grpc
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import ForecastAccuracyLog, ForecastModel, ForecastRun
from app.grpc.forecast_explanation_data_grpc_server import ForecastExplanationDataServicer
from app.grpc.generated import forecast_explanation_data_pb2, forecast_explanation_data_pb2_grpc

_ADDR = "127.0.0.1:0"


def _db_url(username: str, password_env: str) -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv(password_env, "changeme_local_only")
    return f"postgresql+asyncpg://{username}:{password}@{host}:{port}/{database}"


@pytest_asyncio.fixture
async def grpc_server_address() -> AsyncIterator[str]:
    engine = create_async_engine(_db_url("agno_forecasting_app", "DB_PASSWORD"))
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    server = grpc.aio.server()
    forecast_explanation_data_pb2_grpc.add_ForecastExplanationDataServiceServicer_to_server(
        ForecastExplanationDataServicer(session_factory=session_factory), server
    )
    port = server.add_insecure_port(_ADDR)
    await server.start()
    try:
        yield f"127.0.0.1:{port}"
    finally:
        await server.stop(None)
        await engine.dispose()


@pytest_asyncio.fixture
async def migrator_engine() -> AsyncIterator[object]:
    engine = create_async_engine(_db_url("agno_migrator", "DB_MIGRATION_PASSWORD"))
    yield engine
    await engine.dispose()


@pytest.fixture
def tenant_id() -> uuid.UUID:
    return uuid.uuid4()


async def _seed_run_with_model_and_accuracy(
    migrator_engine: object,
    *,
    tenant_id: uuid.UUID,
    with_model: bool = True,
    with_accuracy: bool = True,
) -> uuid.UUID:
    run_id = uuid.uuid4()
    model_id = uuid.uuid4()
    org_unit_id = uuid.uuid4()
    now = datetime.now(UTC)
    async with AsyncSession(migrator_engine) as session, session.begin():  # type: ignore[arg-type]
        if with_model:
            session.add(
                ForecastModel(
                    id=model_id,
                    tenant_id=tenant_id,
                    org_unit_id=org_unit_id,
                    model_type="prophet",
                    target_metric="volume",
                    backtest_mape=Decimal("0.123456"),
                    backtest_wfa=Decimal("0.900000"),
                    status="active",
                    minimum_data_volume_met=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.flush()
        session.add(
            ForecastRun(
                id=run_id,
                tenant_id=tenant_id,
                org_unit_id=org_unit_id,
                forecast_model_id=model_id if with_model else None,
                date_range_start=date.today(),
                date_range_end=date.today() + timedelta(days=1),
                interval_minutes=30,
                status="completed",
                is_cold_start=False,
                requested_at=now,
                completed_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        await session.flush()
        if with_accuracy:
            session.add(
                ForecastAccuracyLog(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    forecast_run_id=run_id,
                    org_unit_id=org_unit_id,
                    actual_volume=Decimal("110.0"),
                    predicted_volume=Decimal("100.0"),
                    mape=Decimal("0.10"),
                    bias=Decimal("-0.10"),
                    evaluated_at=now,
                )
            )
    return run_id


async def test_found_run_returns_model_and_accuracy_data(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    run_id = await _seed_run_with_model_and_accuracy(migrator_engine, tenant_id=tenant_id)

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_explanation_data_pb2_grpc.ForecastExplanationDataServiceStub(channel)
        response = await stub.GetForecastRunForExplanation(
            forecast_explanation_data_pb2.GetForecastRunForExplanationRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is True
    assert response.tenant_id == str(tenant_id)
    assert response.status == "completed"
    assert response.has_model is True
    assert response.model_type == "prophet"
    assert response.backtest_mape == "0.123456"
    assert len(response.accuracy_log) == 1
    # Numeric(10, 6) - decimal-as-string preserves the column's own scale.
    assert response.accuracy_log[0].mape == "0.100000"


async def test_run_with_no_linked_model_reports_has_model_false_not_a_synthetic_row(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    run_id = await _seed_run_with_model_and_accuracy(migrator_engine, tenant_id=tenant_id, with_model=False)

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_explanation_data_pb2_grpc.ForecastExplanationDataServiceStub(channel)
        response = await stub.GetForecastRunForExplanation(
            forecast_explanation_data_pb2.GetForecastRunForExplanationRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is True
    assert response.has_model is False
    assert response.model_type == ""
    assert response.backtest_mape == ""


async def test_nonexistent_forecast_run_is_not_found(grpc_server_address: str, tenant_id: uuid.UUID) -> None:
    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_explanation_data_pb2_grpc.ForecastExplanationDataServiceStub(channel)
        response = await stub.GetForecastRunForExplanation(
            forecast_explanation_data_pb2.GetForecastRunForExplanationRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(uuid.uuid4())
            )
        )

    assert response.found is False


async def test_a_different_tenants_forecast_run_is_not_found(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    other_tenant_id = uuid.uuid4()
    run_id = await _seed_run_with_model_and_accuracy(migrator_engine, tenant_id=other_tenant_id)

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_explanation_data_pb2_grpc.ForecastExplanationDataServiceStub(channel)
        response = await stub.GetForecastRunForExplanation(
            forecast_explanation_data_pb2.GetForecastRunForExplanationRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is False
