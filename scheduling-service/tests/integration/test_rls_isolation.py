"""Python analogue of `test/integration/rls-isolation.spec.ts` and Module 03's
own `test_rls_isolation.py`: proves `scheduling.*` RLS holds both under the
application guard (`tenant_scoped_session`) and independently, by talking to
Postgres directly as `agno_scheduling_app` with no session GUC set at all
(ADR-0002's defense-in-depth, reused unchanged for this schema per ADR-0052).

`scheduling.*` tables have no FK to `core.tenants`/`org.*`/`forecasting.*`
(this service never reads those schemas directly - ADR-0052), so tenant ids
here are arbitrary UUIDs, not rows that need to exist first.
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
from app.db.models import ScheduleJob
from app.db.session import tenant_scoped_session

pytestmark = pytest.mark.asyncio


async def _seed_job(app_engine: AsyncEngine, tenant_id: uuid.UUID) -> uuid.UUID:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    now = datetime.now(UTC)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        job = ScheduleJob(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            org_unit_id=uuid.uuid4(),
            forecast_run_id=uuid.uuid4(),
            date_range_start=date(2026, 1, 1),
            date_range_end=date(2026, 1, 31),
            status="queued",
            constraint_config={},
            requested_by=None,
            solve_duration_ms=None,
            objective_score=None,
            decomposition_plan=None,
            relaxations_applied=None,
            requested_at=now,
            completed_at=None,
            created_at=now,
            updated_at=now,
        )
        session.add(job)
        await session.flush()
        return job.id


async def test_a_tenants_session_only_sees_its_own_jobs(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    job_a_id = await _seed_job(app_engine, tenant_a_id)
    job_b_id = await _seed_job(app_engine, tenant_b_id)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        rows = (await session.scalars(select(ScheduleJob))).all()

    seen_ids = {row.id for row in rows}
    assert job_a_id in seen_ids
    assert job_b_id not in seen_ids


async def test_rls_holds_even_with_the_application_guard_bypassed(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    """Talks to Postgres directly as `agno_scheduling_app`, no
    `set_config('app.current_tenant_id', ...)` at all - simulates a future
    bug where someone queries outside `tenant_scoped_session`."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_scheduling_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        rows = await conn.fetch(
            "SELECT id FROM scheduling.schedule_jobs WHERE tenant_id = ANY($1::uuid[])",
            [tenant_a_id, tenant_b_id],
        )
        # No session tenant bound -> current_setting(...) is NULL -> the
        # tenant_isolation policy's USING clause is false for every row ->
        # zero rows, not all rows. Fail closed.
        assert len(rows) == 0
    finally:
        await conn.close()


async def test_agno_scheduling_app_cannot_read_core_org_or_forecasting_schemas() -> None:
    """ADR-0052: `agno_scheduling_app` gets USAGE on `scheduling` only."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_scheduling_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetch("SELECT 1 FROM core.tenants LIMIT 1")
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetch("SELECT 1 FROM forecasting.forecast_runs LIMIT 1")
    finally:
        await conn.close()


async def test_locked_column_cannot_be_set_directly(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    """ADR-0054: `locked` is `GENERATED ALWAYS` - an explicit write to it must
    be rejected by Postgres, not merely ignored by application code that
    happens not to try."""
    conn = await asyncpg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        user="agno_scheduling_app",
        password=os.getenv("DB_PASSWORD", "changeme_local_only"),
        database=os.getenv("DB_DATABASE", "agno_wfm"),
    )
    try:
        with pytest.raises(asyncpg.PostgresError):
            await conn.execute(
                "INSERT INTO scheduling.shift_assignments "
                "(id, tenant_id, schedule_id, employee_id, shift_start, shift_end, "
                "assignment_source, locked) "
                "VALUES ($1, $2, $3, $4, now(), now() + interval '8 hours', "
                "'auto_generated', true)",
                uuid.uuid4(),
                tenant_a_id,
                uuid.uuid4(),
                uuid.uuid4(),
            )
    finally:
        await conn.close()
