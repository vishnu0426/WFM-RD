"""CRUD for the reusable backlog-age-threshold library — see
`BacklogAgeTemplate`'s own doc comment (`app/db/models.py`) for what this is
and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BacklogAgeTemplateNotFoundError, InvalidBacklogAgeThresholdsError
from app.db.models import BacklogAgeTemplate


async def create_backlog_age_template(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    description: str | None,
    warning_threshold_minutes: int,
    critical_threshold_minutes: int,
) -> BacklogAgeTemplate:
    now = datetime.now(UTC)
    row = BacklogAgeTemplate(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        description=description,
        warning_threshold_minutes=warning_threshold_minutes,
        critical_threshold_minutes=critical_threshold_minutes,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_backlog_age_templates(
    session: AsyncSession, *, tenant_id: uuid.UUID
) -> list[BacklogAgeTemplate]:
    stmt = (
        select(BacklogAgeTemplate)
        .where(BacklogAgeTemplate.tenant_id == tenant_id)
        .order_by(BacklogAgeTemplate.name)
    )
    return list((await session.scalars(stmt)).all())


async def update_backlog_age_template(
    session: AsyncSession, *, tenant_id: uuid.UUID, template_id: uuid.UUID, updates: dict[str, object]
) -> BacklogAgeTemplate:
    row = await session.scalar(
        select(BacklogAgeTemplate).where(
            BacklogAgeTemplate.tenant_id == tenant_id, BacklogAgeTemplate.id == template_id
        )
    )
    if row is None:
        raise BacklogAgeTemplateNotFoundError(template_id)
    for field, value in updates.items():
        setattr(row, field, value)
    warning = updates.get("warning_threshold_minutes", row.warning_threshold_minutes)
    critical = updates.get("critical_threshold_minutes", row.critical_threshold_minutes)
    if critical <= warning:
        raise InvalidBacklogAgeThresholdsError()
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row


async def delete_backlog_age_template(
    session: AsyncSession, *, tenant_id: uuid.UUID, template_id: uuid.UUID
) -> None:
    await session.execute(
        delete(BacklogAgeTemplate).where(
            BacklogAgeTemplate.tenant_id == tenant_id, BacklogAgeTemplate.id == template_id
        )
    )
