"""§3.2's `forecastAccuracyTrend(orgUnitId, period)` as
`GET /v1/forecasting/accuracy/{orgUnitId}` (ADR-0025). Rows are written by
`app/api/v1/actuals.py`'s ingestion trigger, not by this router - this is
read-only.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import AccuracyTrendPoint, AccuracyTrendResponse
from app.core.tenant_context import TenantContext
from app.services import accuracy_service

router = APIRouter(prefix="/v1/forecasting/accuracy", tags=["forecasting-accuracy"])


@router.get("/{org_unit_id}", response_model=AccuracyTrendResponse)
async def get_accuracy_trend(
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> AccuracyTrendResponse:
    rows = await accuracy_service.get_accuracy_trend(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id
    )
    return AccuracyTrendResponse(
        org_unit_id=org_unit_id,
        points=[
            AccuracyTrendPoint(
                forecast_run_id=row.forecast_run_id,
                evaluated_at=row.evaluated_at,
                actual_volume=row.actual_volume,
                predicted_volume=row.predicted_volume,
                mape=row.mape,
                bias=row.bias,
            )
            for row in rows
        ],
    )
