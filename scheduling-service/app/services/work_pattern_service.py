"""CRUD for named recurring rotation cycles — see `WorkPattern`'s own doc
comment (`app/db/models.py`) for what this is and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.db.models import WorkPattern


class WorkPatternNotFoundError(DomainError):
    code = "WORK_PATTERN_NOT_FOUND"
    http_status = 404

    def __init__(self, pattern_id: uuid.UUID) -> None:
        super().__init__(f"Work pattern {pattern_id} not found.")


async def create_work_pattern(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    days: list[uuid.UUID | None],
) -> WorkPattern:
    now = datetime.now(UTC)
    row = WorkPattern(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        days=[str(d) if d is not None else None for d in days],
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_work_patterns(session: AsyncSession, *, tenant_id: uuid.UUID) -> list[WorkPattern]:
    stmt = select(WorkPattern).where(WorkPattern.tenant_id == tenant_id).order_by(WorkPattern.name)
    return list((await session.scalars(stmt)).all())


async def delete_work_pattern(session: AsyncSession, *, tenant_id: uuid.UUID, pattern_id: uuid.UUID) -> None:
    await session.execute(
        delete(WorkPattern).where(WorkPattern.tenant_id == tenant_id, WorkPattern.id == pattern_id)
    )


async def update_work_pattern(
    session: AsyncSession, *, tenant_id: uuid.UUID, pattern_id: uuid.UUID, **fields: Any
) -> WorkPattern:
    """Applies only the keys present in `fields` (the router passes
    `WorkPatternUpdate.model_dump(exclude_unset=True)`) — a key absent from
    the caller's request body is left untouched."""
    row = (
        await session.scalars(
            select(WorkPattern).where(WorkPattern.tenant_id == tenant_id, WorkPattern.id == pattern_id)
        )
    ).first()
    if row is None:
        raise WorkPatternNotFoundError(pattern_id)

    if "days" in fields and fields["days"] is not None:
        fields["days"] = [str(d) if d is not None else None for d in fields["days"]]

    for key, value in fields.items():
        setattr(row, key, value)

    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row
