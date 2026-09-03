"""§3.3's submit/poll job contract:
`POST /v1/forecasting/jobs` and `GET /v1/forecasting/jobs/{jobId}`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_idempotency_key, get_tenant_context
from app.api.v1.schemas import (
    DateRange,
    ForecastDataPointResponse,
    ForecastJobRequest,
    ForecastJobResponse,
    ForecastRunDetail,
)
from app.core.tenant_context import TenantContext
from app.events import nats_publisher
from app.services import job_service

router = APIRouter(prefix="/v1/forecasting/jobs", tags=["forecasting-jobs"])


@router.post("", response_model=ForecastJobResponse)
async def submit_forecast_job(
    body: ForecastJobRequest,
    request: Request,
    response: Response,
    idempotency_key: str = Depends(get_idempotency_key),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ForecastJobResponse:
    run, created = await job_service.create_job(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=body.org_unit_id,
        date_range_start=body.date_range.start,
        date_range_end=body.date_range.end,
        interval_minutes=body.interval_minutes,
        idempotency_key=idempotency_key,
        created_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    response.status_code = 201 if created else 200

    # §3.4 - only for a run this call actually just completed (cold-start or
    # model-fulfilled, Phase 2/3), never for an idempotent replay or a run
    # still sitting at `queued`, so a redelivered `Idempotency-Key` can never
    # double-publish.
    if created and run.status == "completed":
        await nats_publisher.publish_run_completed(
            request.app.state.jetstream,
            tenant_id=run.tenant_id,
            forecast_run_id=run.id,
            org_unit_id=run.org_unit_id,
            status="completed",
        )

    return ForecastJobResponse(job_id=run.id, status=run.status)


@router.get("", response_model=list[ForecastRunDetail])
async def list_forecast_jobs(
    org_unit_id: uuid.UUID = Query(...),
    limit: int = Query(default=20, gt=0, le=100),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ForecastRunDetail]:
    runs = await job_service.list_jobs(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id, limit=limit
    )
    return [
        ForecastRunDetail(
            id=run.id,
            tenant_id=run.tenant_id,
            org_unit_id=run.org_unit_id,
            forecast_model_id=run.forecast_model_id,
            date_range=DateRange(start=run.date_range_start, end=run.date_range_end),
            interval_minutes=run.interval_minutes,
            status=run.status,
            is_cold_start=run.is_cold_start,
            requested_at=run.requested_at,
            completed_at=run.completed_at,
        )
        for run in runs
    ]


@router.get("/{job_id}", response_model=ForecastRunDetail)
async def get_forecast_job(
    job_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ForecastRunDetail:
    run = await job_service.get_job(session, tenant_id=uuid.UUID(context.tenant_id), job_id=job_id)
    return ForecastRunDetail(
        id=run.id,
        tenant_id=run.tenant_id,
        org_unit_id=run.org_unit_id,
        forecast_model_id=run.forecast_model_id,
        date_range=DateRange(start=run.date_range_start, end=run.date_range_end),
        interval_minutes=run.interval_minutes,
        status=run.status,
        is_cold_start=run.is_cold_start,
        requested_at=run.requested_at,
        completed_at=run.completed_at,
    )


# No REST surface previously exposed `ForecastDataPoint` (the actual
# per-interval predictions) at all — only run metadata via the endpoint
# above. §3.2's "trend view" the frontend needs (predicted volume/AHT/
# shrinkage over the run's date range) has nothing to read without this;
# the data was always persisted (`inference_service`/`cold_start_service`),
# just never read back over HTTP. Same "minimal REST readback" posture this
# service already uses elsewhere (see the module README's Phase 2 note on
# `GET /v1/scheduling/jobs/{jobId}/schedule` in the sibling service).
@router.get("/{job_id}/data-points", response_model=list[ForecastDataPointResponse])
async def get_forecast_job_data_points(
    job_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ForecastDataPointResponse]:
    points = await job_service.get_data_points(session, tenant_id=uuid.UUID(context.tenant_id), job_id=job_id)
    return [
        ForecastDataPointResponse(
            interval_start=p.interval_start,
            predicted_volume=p.predicted_volume,
            predicted_aht_seconds=p.predicted_aht_seconds,
            predicted_shrinkage_pct=p.predicted_shrinkage_pct,
            confidence_lower=p.confidence_lower,
            confidence_upper=p.confidence_upper,
            required_headcount=p.required_headcount,
        )
        for p in points
    ]
