"""§7's `SpecialEvent` tagging endpoints (ADR-0025). `POST` creates a
tenant- or org-unit-scoped calendar tag; `GET` lists everything applicable
to an org unit (its own events plus tenant-wide ones). Feeding these into
training is `training_service.retrain`'s job, not this router's - see
`app/services/special_event_service.list_holidays_for_training`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import DateRange, SpecialEventRequest, SpecialEventResponse
from app.core.tenant_context import TenantContext
from app.db.models import SpecialEvent
from app.services import special_event_service

router = APIRouter(prefix="/v1/forecasting/special-events", tags=["forecasting-special-events"])


def _to_response(row: SpecialEvent) -> SpecialEventResponse:
    return SpecialEventResponse(
        id=row.id,
        org_unit_id=row.org_unit_id,
        event_type=row.event_type,
        date_range=DateRange(start=row.date_range_start, end=row.date_range_end),
        expected_volume_multiplier=row.expected_volume_multiplier,
        tagged_by=row.tagged_by,
    )


@router.post("", response_model=SpecialEventResponse)
async def create_special_event(
    body: SpecialEventRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> SpecialEventResponse:
    row = await special_event_service.create_special_event(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=body.org_unit_id,
        event_type=body.event_type,
        date_range_start=body.date_range.start,
        date_range_end=body.date_range.end,
        expected_volume_multiplier=body.expected_volume_multiplier,
        tagged_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    return _to_response(row)


@router.get("", response_model=list[SpecialEventResponse])
async def list_special_events(
    org_unit_id: uuid.UUID | None = Query(default=None),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[SpecialEventResponse]:
    rows = await special_event_service.list_special_events(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id
    )
    return [_to_response(row) for row in rows]
