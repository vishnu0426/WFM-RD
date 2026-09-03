"""Recording and listing for backlog-age readings — see `BacklogSnapshot`'s
own doc comment (`app/db/models.py`) for what this is and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BacklogSnapshot


async def record_backlog_snapshot(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    template_id: uuid.UUID | None,
    item_count: int,
    oldest_item_age_minutes: int,
) -> BacklogSnapshot:
    row = BacklogSnapshot(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        template_id=template_id,
        item_count=item_count,
        oldest_item_age_minutes=oldest_item_age_minutes,
        recorded_at=datetime.now(UTC),
    )
    session.add(row)
    await session.flush()
    return row


async def list_backlog_snapshots(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, limit: int
) -> list[BacklogSnapshot]:
    stmt = (
        select(BacklogSnapshot)
        .where(BacklogSnapshot.tenant_id == tenant_id, BacklogSnapshot.org_unit_id == org_unit_id)
        .order_by(BacklogSnapshot.recorded_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())
