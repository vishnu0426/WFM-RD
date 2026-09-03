"""Python analogue of `test/integration/rls-isolation.spec.ts`: proves
`forecasting.*` RLS holds both under the application guard
(`tenant_scoped_session`) and independently, by talking to Postgres directly
as `agno_forecasting_app` with no session GUC set at all (ADR-0002's
defense-in-depth, reused unchanged for this schema per ADR-0017).

Unlike Module 01/02's fixtures, `forecasting.*` tables have no FK to
`core.tenants` (this service never reads Module 02's/01's schema directly -
see the design doc), so tenant ids here are arbitrary UUIDs, not rows that
need to exist first.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, date, datetime

import asyncpg
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastRun
from app.db.session import tenant_scoped_session

pytestmark = pytest.mark.asyncio


async def _seed_run(app_engine: AsyncEngine, tenant_id: uuid.UUID) -> uuid.UUID:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    now = datetime.now(UTC)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        run = ForecastRun(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            org_unit_id=uuid.uuid4(),
            forecast_model_id=None,
            date_range_start=date(2026, 1, 1),
            date_range_end=date(2026, 1, 31),
            interval_minutes=30,
            status="queued",
            is_cold_start=False,
            created_by=None,
            requested_at=now,
            completed_at=None,
            created_at=now,
            updated_at=now,
        )
        session.add(run)
        await session.flush()
        return run.id


async def test_a_tenants_session_only_sees_its_own_runs(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    run_a_id = await _seed_run(app_engine, tenant_a_id)
    run_b_id = await _seed_run(app_engine, tenant_b_id)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        rows = (await session.scalars(select(ForecastRun))).all()

    seen_ids = {row.id for row in rows}
    assert run_a_id in seen_ids
    assert run_b_id not in seen_ids


async def test_rls_holds_even_with_the_application_guard_bypassed(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    """Talks to Postgres directly as `agno_forecasting_app`, no
    `set_config('app.current_tenant_id', ...)` at all - simulates a future
    bug where someone queries outside `tenant_scoped_session`."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_forecasting_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        rows = await conn.fetch(
            "SELECT id FROM forecasting.forecast_runs WHERE tenant_id = ANY($1::uuid[])",
            [tenant_a_id, tenant_b_id],
        )
        # No session tenant bound -> current_setting(...) is NULL -> the
        # tenant_isolation policy's USING clause is false for every row ->
        # zero rows, not all rows. Fail closed.
        assert len(rows) == 0
    finally:
        await conn.close()


async def test_agno_forecasting_app_cannot_read_core_or_org_schemas() -> None:
    """ADR-0017: `agno_forecasting_app` gets USAGE on `forecasting` only."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_forecasting_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetch("SELECT 1 FROM core.tenants LIMIT 1")
    finally:
        await conn.close()


async def test_agno_forecasting_app_cannot_write_tenant_settings(tenant_a_id: uuid.UUID) -> None:
    """ADR-0020, Gap 2: `tenant_settings` is SELECT-only for the app role -
    no application code path can self-grant TFT entitlement or enable
    cross-tenant cold-start matching."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_forecasting_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.execute(
                "INSERT INTO forecasting.tenant_settings (tenant_id, tft_entitled) VALUES ($1, true)",
                tenant_a_id,
            )
    finally:
        await conn.close()


async def test_rls_holds_for_historical_actuals_when_bypassed(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_forecasting_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        rows = await conn.fetch(
            "SELECT id FROM forecasting.historical_actuals WHERE tenant_id = ANY($1::uuid[])",
            [tenant_a_id, tenant_b_id],
        )
        assert len(rows) == 0
    finally:
        await conn.close()
