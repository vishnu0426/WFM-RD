"""§2.2's "surface the specific failure reason to the planner UI, not a
generic 'forecast unavailable'" requirement, as an actual queryable
endpoint."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import DataQualityCheckResponse
from app.core.tenant_context import TenantContext
from app.services import data_quality_service

router = APIRouter(prefix="/v1/forecasting/data-quality", tags=["forecasting-data-quality"])


@router.get("/{org_unit_id}", response_model=DataQualityCheckResponse)
async def evaluate_data_quality(
    org_unit_id: uuid.UUID,
    model_type: str = Query(pattern="^(sarima|prophet|neuralprophet|lightgbm|tft)$"),
    target_metric: str = Query(pattern="^(volume|aht|shrinkage)$"),
    interval_minutes: int = Query(gt=0, default=30),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> DataQualityCheckResponse:
    check = await data_quality_service.evaluate_gate(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=org_unit_id,
        model_type=model_type,
        target_metric=target_metric,
        interval_minutes=interval_minutes,
    )
    return DataQualityCheckResponse(
        id=check.id,
        org_unit_id=check.org_unit_id,
        model_type=check.model_type,
        target_metric=check.target_metric,
        passed=check.passed,
        failure_reason=check.failure_reason,
        total_expected_intervals=check.total_expected_intervals,
        missing_intervals=check.missing_intervals,
        evaluated_at=check.evaluated_at,
    )
