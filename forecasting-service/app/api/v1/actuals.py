"""ADR-0020's landing-zone endpoint for `historical_actuals` - not an
ingestion pipeline, just what the gate/cold-start/future-training logic
reads from. Phase 7 (ADR-0025) also makes this the trigger point for
`ForecastAccuracyLog` population - the natural place this service first
learns "time has passed and we now know what really happened.\""""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import IngestActualsRequest, IngestActualsResponse
from app.core.tenant_context import TenantContext
from app.services import accuracy_service, historical_actuals_service
from app.services.historical_actuals_service import ActualPoint

router = APIRouter(prefix="/v1/forecasting/actuals", tags=["forecasting-actuals"])


@router.post("", response_model=IngestActualsResponse)
async def ingest_actuals(
    body: IngestActualsRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> IngestActualsResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    points = [
        ActualPoint(
            interval_start=point.interval_start,
            actual_volume=point.actual_volume,
            actual_aht_seconds=point.actual_aht_seconds,
            actual_shrinkage_pct=point.actual_shrinkage_pct,
        )
        for point in body.points
    ]
    ingested = await historical_actuals_service.ingest_actuals(
        session,
        tenant_id=tenant_id,
        org_unit_id=body.org_unit_id,
        points=points,
    )
    accuracy_logged = await accuracy_service.log_accuracy_for_new_actuals(
        session, tenant_id=tenant_id, org_unit_id=body.org_unit_id, points=points
    )
    return IngestActualsResponse(ingested=ingested, accuracy_logged=accuracy_logged)
