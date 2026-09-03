"""§7's `SpecialEvent` tagging (ADR-0025, Decision 5). Create/list only in
this phase - `training_service.retrain` reads `event_type='holiday'` rows
directly rather than through this module, since it needs a different query
shape (date-range overlap against a training/forecast window, not a
tenant-wide listing).
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import SpecialEvent


async def create_special_event(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID | None,
    event_type: str,
    date_range_start: date,
    date_range_end: date,
    expected_volume_multiplier: Decimal | None,
    tagged_by: uuid.UUID | None,
) -> SpecialEvent:
    now = datetime.now(UTC)
    row = SpecialEvent(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        event_type=event_type,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        expected_volume_multiplier=expected_volume_multiplier,
        tagged_by=tagged_by,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_special_events(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID | None = None
) -> list[SpecialEvent]:
    """`org_unit_id=None` returns every tenant-wide + org-unit-specific event
    (the "browse everything" case). Passing an id narrows to that org unit's
    own events plus tenant-wide (`org_unit_id IS NULL`) ones - matching how
    `training_service.retrain` will interpret "applies to this org unit.\""""
    stmt = select(SpecialEvent).where(SpecialEvent.tenant_id == tenant_id)
    if org_unit_id is not None:
        stmt = stmt.where(
            (SpecialEvent.org_unit_id == org_unit_id) | (SpecialEvent.org_unit_id.is_(None))
        )
    stmt = stmt.order_by(SpecialEvent.date_range_start)
    return list((await session.scalars(stmt)).all())


async def list_holidays_for_training(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    window_start: date,
    window_end: date,
) -> list[SpecialEvent]:
    """ADR-0025 Decision 5: `event_type='holiday'` rows (org-unit-specific or
    tenant-wide) whose date range overlaps `[window_start, window_end]` -
    covers both the training lookback and the forecast horizon, since Prophet
    needs holiday rows spanning the dates it's asked to predict, not just the
    dates it's trained on."""
    stmt = select(SpecialEvent).where(
        SpecialEvent.tenant_id == tenant_id,
        (SpecialEvent.org_unit_id == org_unit_id) | (SpecialEvent.org_unit_id.is_(None)),
        SpecialEvent.event_type == "holiday",
        SpecialEvent.date_range_start <= window_end,
        SpecialEvent.date_range_end >= window_start,
    )
    return list((await session.scalars(stmt)).all())
