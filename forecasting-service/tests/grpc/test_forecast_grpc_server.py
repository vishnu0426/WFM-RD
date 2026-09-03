"""Phase 6 (ADR-0059)'s new `ForecastService.GetForecastRequirements` gRPC
surface, proven against a real `grpc.aio.Server` (bound to a real socket, a
real `grpc.aio` client on the other end - not an in-process stub call) and a
real Postgres. Deliberately outside `tests/integration/` - that package's
own `conftest.py` imports `app.ml.training`, which transitively pulls in
this service's full ML stack (`torch`/`ray`/`mlflow`/`lightgbm`/`prophet`/
`pytorch-forecasting`/`lightning`), none of which this new gRPC module
needs or imports itself. Requires a reachable Postgres with migrations
applied, same posture as `tests/integration/conftest.py`.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import grpc
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.models import ForecastDataPoint, ForecastRun
from app.grpc.forecast_grpc_server import ForecastServicer
from app.grpc.generated import forecast_pb2, forecast_pb2_grpc

_ADDR = "127.0.0.1:0"


def _db_url() -> str:
    import os

    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv("DB_PASSWORD", "changeme_local_only")
    return f"postgresql+asyncpg://agno_forecasting_app:{password}@{host}:{port}/{database}"


@pytest_asyncio.fixture
async def grpc_server_address() -> AsyncIterator[str]:
    engine = create_async_engine(_db_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    server = grpc.aio.server()
    forecast_pb2_grpc.add_ForecastServiceServicer_to_server(
        ForecastServicer(session_factory=session_factory), server
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
    import os

    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    migrator_password = os.getenv("DB_MIGRATION_PASSWORD", "changeme_local_only")
    engine = create_async_engine(
        f"postgresql+asyncpg://agno_migrator:{migrator_password}@{host}:{port}/{database}"
    )
    yield engine
    await engine.dispose()


@pytest.fixture
def tenant_id() -> uuid.UUID:
    return uuid.uuid4()


async def _seed_forecast_run(
    migrator_engine: object,
    *,
    tenant_id: uuid.UUID,
    status: str = "completed",
    interval_minutes: int = 30,
    points: list[tuple[datetime, Decimal | None]] | None = None,
) -> uuid.UUID:
    from sqlalchemy.ext.asyncio import AsyncSession

    run_id = uuid.uuid4()
    now = datetime.now(UTC)
    async with AsyncSession(migrator_engine) as session, session.begin():  # type: ignore[arg-type]
        session.add(
            ForecastRun(
                id=run_id,
                tenant_id=tenant_id,
                org_unit_id=uuid.uuid4(),
                date_range_start=date.today(),
                date_range_end=date.today() + timedelta(days=1),
                interval_minutes=interval_minutes,
                status=status,
                is_cold_start=False,
                requested_at=now,
                completed_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        await session.flush()
        for interval_start, required_headcount in points or []:
            session.add(
                ForecastDataPoint(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    forecast_run_id=run_id,
                    interval_start=interval_start,
                    required_headcount=required_headcount,
                    created_at=now,
                )
            )
    return run_id


async def test_found_run_returns_its_interval_requirements(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    # Within the current month - forecast_data_points is monthly-partitioned
    # with only a bootstrap window of partitions (current month ± 1,
    # ADR-0018), not one for every calendar month.
    day = datetime.now(UTC).replace(hour=9, minute=0, second=0, microsecond=0)
    run_id = await _seed_forecast_run(
        migrator_engine,
        tenant_id=tenant_id,
        points=[(day, Decimal("4.50")), (day + timedelta(minutes=30), Decimal("6.00"))],
    )

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_pb2_grpc.ForecastServiceStub(channel)
        response = await stub.GetForecastRequirements(
            forecast_pb2.GetForecastRequirementsRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is True
    assert len(response.requirements) == 2
    assert response.requirements[0].interval_start == day.isoformat()
    assert response.requirements[0].interval_minutes == 30
    assert response.requirements[0].required_headcount == "4.50"
    assert response.requirements[1].required_headcount == "6.00"


async def test_null_required_headcount_is_an_empty_string_not_zero(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    day = datetime.now(UTC).replace(hour=9, minute=0, second=0, microsecond=0)
    run_id = await _seed_forecast_run(migrator_engine, tenant_id=tenant_id, points=[(day, None)])

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_pb2_grpc.ForecastServiceStub(channel)
        response = await stub.GetForecastRequirements(
            forecast_pb2.GetForecastRequirementsRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.requirements[0].required_headcount == ""


async def test_nonexistent_forecast_run_is_not_found(grpc_server_address: str, tenant_id: uuid.UUID) -> None:
    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_pb2_grpc.ForecastServiceStub(channel)
        response = await stub.GetForecastRequirements(
            forecast_pb2.GetForecastRequirementsRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(uuid.uuid4())
            )
        )

    assert response.found is False
    assert list(response.requirements) == []


async def test_a_still_running_forecast_run_is_not_found(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    run_id = await _seed_forecast_run(migrator_engine, tenant_id=tenant_id, status="running")

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_pb2_grpc.ForecastServiceStub(channel)
        response = await stub.GetForecastRequirements(
            forecast_pb2.GetForecastRequirementsRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is False


async def test_a_different_tenants_forecast_run_is_not_found(
    grpc_server_address: str, migrator_engine: object, tenant_id: uuid.UUID
) -> None:
    other_tenant_id = uuid.uuid4()
    run_id = await _seed_forecast_run(migrator_engine, tenant_id=other_tenant_id)

    async with grpc.aio.insecure_channel(grpc_server_address) as channel:
        stub = forecast_pb2_grpc.ForecastServiceStub(channel)
        response = await stub.GetForecastRequirements(
            forecast_pb2.GetForecastRequirementsRequest(
                tenant_id=str(tenant_id), forecast_run_id=str(run_id)
            )
        )

    assert response.found is False
