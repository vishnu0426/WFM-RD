"""CRUD for the reusable shift-template library — see `ShiftTemplate`'s own
doc comment (`app/db/models.py`) for what this is and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.db.models import ShiftTemplate


class ShiftTemplateNotFoundError(DomainError):
    code = "SHIFT_TEMPLATE_NOT_FOUND"
    http_status = 404

    def __init__(self, template_id: uuid.UUID) -> None:
        super().__init__(f"Shift template {template_id} not found.")


def _parse_time(value: str) -> time:
    hour, minute = value.split(":")
    return time(int(hour), int(minute))


async def create_shift_template(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    start_time: str,
    end_time: str,
    break_minutes: int,
    required_skill_id: uuid.UUID | None,
    default_headcount: int,
) -> ShiftTemplate:
    now = datetime.now(UTC)
    row = ShiftTemplate(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        start_time=_parse_time(start_time),
        end_time=_parse_time(end_time),
        break_minutes=break_minutes,
        required_skill_id=required_skill_id,
        default_headcount=default_headcount,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_shift_templates(session: AsyncSession, *, tenant_id: uuid.UUID) -> list[ShiftTemplate]:
    stmt = select(ShiftTemplate).where(ShiftTemplate.tenant_id == tenant_id).order_by(ShiftTemplate.name)
    return list((await session.scalars(stmt)).all())


async def delete_shift_template(
    session: AsyncSession, *, tenant_id: uuid.UUID, template_id: uuid.UUID
) -> None:
    # Tenant-scoped WHERE, not just id — RLS already enforces this, but a
    # caller passing another tenant's real id should get a silent no-op
    # (0 rows deleted), never a chance to even attempt a cross-tenant
    # delete at the application-code level.
    await session.execute(
        delete(ShiftTemplate).where(ShiftTemplate.tenant_id == tenant_id, ShiftTemplate.id == template_id)
    )


async def update_shift_template(
    session: AsyncSession, *, tenant_id: uuid.UUID, template_id: uuid.UUID, **fields: Any
) -> ShiftTemplate:
    """Applies only the keys present in `fields` (the router passes
    `ShiftTemplateUpdate.model_dump(exclude_unset=True)`) — a key simply
    absent from the caller's request body is left untouched, distinct from a
    key present with an explicit `null` (which does get applied, e.g. to
    clear `required_skill_id`)."""
    row = (
        await session.scalars(
            select(ShiftTemplate).where(
                ShiftTemplate.tenant_id == tenant_id, ShiftTemplate.id == template_id
            )
        )
    ).first()
    if row is None:
        raise ShiftTemplateNotFoundError(template_id)

    if "start_time" in fields and fields["start_time"] is not None:
        fields["start_time"] = _parse_time(fields["start_time"])
    if "end_time" in fields and fields["end_time"] is not None:
        fields["end_time"] = _parse_time(fields["end_time"])

    for key, value in fields.items():
        setattr(row, key, value)

    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row
