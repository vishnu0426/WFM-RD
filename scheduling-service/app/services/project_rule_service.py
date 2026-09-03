"""CRUD for the reusable project-rule library — see `ProjectRule`'s own doc
comment (`app/db/models.py`) for what this is and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProjectRuleNotFoundError
from app.db.models import ProjectRule


async def create_project_rule(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    description: str | None,
    max_consecutive_working_days: int,
    min_rest_hours_between_shifts: Decimal,
    min_shift_length_minutes: int,
    max_shift_length_minutes: int | None,
    allows_overtime: bool,
) -> ProjectRule:
    now = datetime.now(UTC)
    row = ProjectRule(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        description=description,
        max_consecutive_working_days=max_consecutive_working_days,
        min_rest_hours_between_shifts=min_rest_hours_between_shifts,
        min_shift_length_minutes=min_shift_length_minutes,
        max_shift_length_minutes=max_shift_length_minutes,
        allows_overtime=allows_overtime,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_project_rules(session: AsyncSession, *, tenant_id: uuid.UUID) -> list[ProjectRule]:
    stmt = select(ProjectRule).where(ProjectRule.tenant_id == tenant_id).order_by(ProjectRule.name)
    return list((await session.scalars(stmt)).all())


async def update_project_rule(
    session: AsyncSession, *, tenant_id: uuid.UUID, rule_id: uuid.UUID, updates: dict[str, object]
) -> ProjectRule:
    row = await session.scalar(
        select(ProjectRule).where(ProjectRule.tenant_id == tenant_id, ProjectRule.id == rule_id)
    )
    if row is None:
        raise ProjectRuleNotFoundError(str(rule_id))
    for field, value in updates.items():
        setattr(row, field, value)
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row


async def delete_project_rule(session: AsyncSession, *, tenant_id: uuid.UUID, rule_id: uuid.UUID) -> None:
    await session.execute(
        delete(ProjectRule).where(ProjectRule.tenant_id == tenant_id, ProjectRule.id == rule_id)
    )
