"""CRUD + decision workflow for shift event requests — see
`ShiftEventRequest`'s own doc comment (`app/db/models.py`) for the
`event_type`-discriminator design behind "Shift Events"/"VTO Events"/
"OT Extensions"."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.db.models import ShiftEventRequest


class ShiftEventRequestNotFoundError(DomainError):
    code = "SHIFT_EVENT_REQUEST_NOT_FOUND"
    http_status = 404

    def __init__(self, request_id: uuid.UUID) -> None:
        super().__init__(f"Shift event request {request_id} not found.")


class ShiftEventRequestAlreadyDecidedError(DomainError):
    code = "SHIFT_EVENT_REQUEST_ALREADY_DECIDED"
    http_status = 409

    def __init__(self, request_id: uuid.UUID, status: str) -> None:
        super().__init__(f"Shift event request {request_id} was already decided (status={status}).")


async def create_request(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    employee_id: uuid.UUID,
    event_type: str,
    shift_date: date,
    requested_hours: Decimal | None,
    reason: str,
    requested_by: uuid.UUID | None,
) -> ShiftEventRequest:
    row = ShiftEventRequest(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        employee_id=employee_id,
        event_type=event_type,
        shift_date=shift_date,
        requested_hours=requested_hours,
        reason=reason,
        status="pending",
        requested_by=requested_by,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    await session.flush()
    return row


async def list_requests(
    session: AsyncSession, *, tenant_id: uuid.UUID, event_type: str, status: str | None
) -> list[ShiftEventRequest]:
    stmt = select(ShiftEventRequest).where(
        ShiftEventRequest.tenant_id == tenant_id, ShiftEventRequest.event_type == event_type
    )
    if status is not None:
        stmt = stmt.where(ShiftEventRequest.status == status)
    stmt = stmt.order_by(ShiftEventRequest.created_at.desc())
    return list((await session.scalars(stmt)).all())


async def decide_request(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    request_id: uuid.UUID,
    decision: str,
    decision_reason: str | None,
    decided_by: uuid.UUID | None,
) -> ShiftEventRequest:
    row = (
        await session.scalars(
            select(ShiftEventRequest).where(
                ShiftEventRequest.tenant_id == tenant_id, ShiftEventRequest.id == request_id
            )
        )
    ).first()
    if row is None:
        raise ShiftEventRequestNotFoundError(request_id)
    if row.status != "pending":
        raise ShiftEventRequestAlreadyDecidedError(request_id, row.status)

    row.status = decision
    row.decision_reason = decision_reason
    row.decided_by = decided_by
    row.decided_at = datetime.now(UTC)
    await session.flush()
    return row
