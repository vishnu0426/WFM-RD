"""Shift event request/decision CRUD - the unified mechanism behind "Shift
Events"/"VTO Events"/"OT Extensions" in the reference console's own menu.
See `ShiftEventRequest`'s own doc comment (`app/db/models.py`) for the
`event_type`-discriminator design.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    CreateShiftEventRequestInput,
    DecideShiftEventRequestInput,
    ShiftEventRequestResponse,
)
from app.core.tenant_context import TenantContext
from app.db.models import ShiftEventRequest
from app.services import shift_event_request_service

router = APIRouter(prefix="/v1/scheduling/shift-event-requests", tags=["scheduling-shift-event-requests"])


def _to_response(row: ShiftEventRequest) -> ShiftEventRequestResponse:
    return ShiftEventRequestResponse(
        id=row.id,
        employee_id=row.employee_id,
        event_type=row.event_type,
        shift_date=row.shift_date,
        requested_hours=row.requested_hours,
        reason=row.reason,
        status=row.status,
        decision_reason=row.decision_reason,
        requested_by=row.requested_by,
        decided_by=row.decided_by,
        decided_at=row.decided_at,
        created_at=row.created_at,
    )


@router.post("", response_model=ShiftEventRequestResponse, status_code=status.HTTP_201_CREATED)
async def create_shift_event_request(
    body: CreateShiftEventRequestInput,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ShiftEventRequestResponse:
    row = await shift_event_request_service.create_request(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        employee_id=body.employee_id,
        event_type=body.event_type,
        shift_date=body.shift_date,
        requested_hours=body.requested_hours,
        reason=body.reason,
        requested_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    return _to_response(row)


@router.get("", response_model=list[ShiftEventRequestResponse])
async def list_shift_event_requests(
    event_type: str = Query(..., pattern="^(shift_change|vto|overtime_extension)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(pending|approved|rejected)$"),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ShiftEventRequestResponse]:
    tenant_id = uuid.UUID(context.tenant_id)
    rows = await shift_event_request_service.list_requests(
        session, tenant_id=tenant_id, event_type=event_type, status=status_filter
    )
    return [_to_response(row) for row in rows]


@router.post("/{request_id}/decide", response_model=ShiftEventRequestResponse)
async def decide_shift_event_request(
    request_id: uuid.UUID,
    body: DecideShiftEventRequestInput,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ShiftEventRequestResponse:
    row = await shift_event_request_service.decide_request(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        request_id=request_id,
        decision=body.decision,
        decision_reason=body.decision_reason,
        decided_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    return _to_response(row)
