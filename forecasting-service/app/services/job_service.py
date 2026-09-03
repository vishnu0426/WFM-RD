"""§3.3's job-submission scaffolding. `create_job` is idempotent per §3.3's
`Idempotency-Key` requirement (design doc assumption #5): a previously-seen
`(tenant_id, idempotency_key)` pair returns the original run instead of
creating a second one.

Phase 2 (ADR-0020) wires the `DataQualityCheck` gate + cold-start fallback
into submission itself: the gate is evaluated with `model_type='sarima'`
(the loosest non-TFT bar) against `target_metric='volume'` as the
run-defining discriminator for `is_cold_start`. Phase 3 (ADR-0021, Decision
2) adds a fourth branch once the gate passes. Four outcomes overall:
  1. Gate fails, no cold-start donors -> `InsufficientDataError` (422), no
     `ForecastRun` row created at all.
  2. Gate fails, same-tenant donor queues exist -> `is_cold_start: true`,
     seeded synchronously (cheap local computation, no Ray dependency),
     `status: completed`.
  3. Gate passes, an `active` `ForecastModel` already exists for
     `(org_unit_id, 'volume')` -> inference runs synchronously (a fitted
     model's `.forecast()` is low-seconds work), `status: completed`,
     `forecast_model_id` set.
  4. Gate passes, no `active` model exists yet -> `status: queued`. Nobody
     auto-triggers training inline (`/retrain` can take up to 2 minutes -
     doing that here would blow the job-submission SLO) - the caller is
     expected to call `POST /v1/forecasting/models/{orgUnitId}/retrain`
     first. A real stated gap, not silently papered over - see the Phase 3
     production readiness checklist.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ForecastRunNotFoundError, InsufficientDataError
from app.db.models import ForecastDataPoint, ForecastRun, IdempotencyKey
from app.services import cold_start_service, data_quality_service, inference_service, training_service

GATE_DISCRIMINATOR_MODEL_TYPE = "sarima"
GATE_DISCRIMINATOR_TARGET_METRIC = "volume"


async def create_job(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    date_range_start: date,
    date_range_end: date,
    interval_minutes: int,
    idempotency_key: str,
    created_by: uuid.UUID | None,
) -> tuple[ForecastRun, bool]:
    """Returns `(run, created)` - `created` is False when an existing
    idempotency key was matched, so the caller can respond 200 vs 201.
    Raises `InsufficientDataError` if the gate fails with no cold-start
    donors available (only on the first submission of a given idempotency
    key - a replay never re-evaluates the gate)."""
    existing = await session.scalar(
        select(IdempotencyKey).where(
            IdempotencyKey.tenant_id == tenant_id,
            IdempotencyKey.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        run = await session.scalar(
            select(ForecastRun).where(
                ForecastRun.tenant_id == tenant_id,
                ForecastRun.id == existing.forecast_run_id,
            )
        )
        if run is not None:
            return run, False

    check = await data_quality_service.evaluate_gate(
        session,
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        model_type=GATE_DISCRIMINATOR_MODEL_TYPE,
        target_metric=GATE_DISCRIMINATOR_TARGET_METRIC,
        interval_minutes=interval_minutes,
    )

    is_cold_start = False
    donor_org_unit_ids: list[uuid.UUID] = []
    active_model = None
    if not check.passed:
        donor_org_unit_ids = await cold_start_service.select_similar_queues(
            session, tenant_id=tenant_id, target_org_unit_id=org_unit_id
        )
        if not donor_org_unit_ids:
            raise InsufficientDataError(
                "Not enough historical data to forecast this org unit, and no "
                "similar queues are available to seed a cold-start forecast.",
                {
                    "orgUnitId": str(org_unit_id),
                    "failureReason": check.failure_reason,
                    "dataQualityCheckId": str(check.id),
                },
            )
        is_cold_start = True
    else:
        active_model = await training_service.get_active_model(
            session,
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            target_metric=GATE_DISCRIMINATOR_TARGET_METRIC,
        )

    is_fulfilled = is_cold_start or active_model is not None
    now = datetime.now(UTC)
    run = ForecastRun(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        forecast_model_id=active_model.id if active_model is not None else None,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        interval_minutes=interval_minutes,
        status="completed" if is_fulfilled else "queued",
        is_cold_start=is_cold_start,
        created_by=created_by,
        requested_at=now,
        completed_at=now if is_fulfilled else None,
        created_at=now,
        updated_at=now,
    )
    session.add(run)
    await session.flush()

    if is_cold_start:
        await cold_start_service.seed_cold_start_forecast(
            session,
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            forecast_run_id=run.id,
            donor_org_unit_ids=donor_org_unit_ids,
            date_range_start=date_range_start,
            date_range_end=date_range_end,
            interval_minutes=interval_minutes,
        )
    elif active_model is not None:
        await inference_service.run_inference(
            session,
            tenant_id=tenant_id,
            forecast_run_id=run.id,
            model=active_model,
            date_range_start=date_range_start,
            date_range_end=date_range_end,
            interval_minutes=interval_minutes,
        )

    session.add(
        IdempotencyKey(
            tenant_id=tenant_id,
            idempotency_key=idempotency_key,
            forecast_run_id=run.id,
            created_at=now,
        )
    )
    return run, True


async def get_job(session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID) -> ForecastRun:
    run = await session.scalar(
        select(ForecastRun).where(ForecastRun.tenant_id == tenant_id, ForecastRun.id == job_id)
    )
    if run is None:
        raise ForecastRunNotFoundError(str(job_id))
    return run


async def list_jobs(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, limit: int = 20
) -> list[ForecastRun]:
    """Real history for Tactical Forecast — there was previously no way to
    see past runs for an org unit, only look one up by a job id you already
    had (a real, now-closed gap)."""
    stmt = (
        select(ForecastRun)
        .where(ForecastRun.tenant_id == tenant_id, ForecastRun.org_unit_id == org_unit_id)
        .order_by(ForecastRun.requested_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


async def get_data_points(
    session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID
) -> list[ForecastDataPoint]:
    """Per-interval predictions for a run — confirms the run exists (and is
    this tenant's) the same way `get_job` does, rather than returning an
    empty list for a nonexistent/foreign run indistinguishably from a real
    run with no points."""
    await get_job(session, tenant_id=tenant_id, job_id=job_id)
    result = await session.scalars(
        select(ForecastDataPoint)
        .where(ForecastDataPoint.tenant_id == tenant_id, ForecastDataPoint.forecast_run_id == job_id)
        .order_by(ForecastDataPoint.interval_start)
    )
    return list(result.all())
