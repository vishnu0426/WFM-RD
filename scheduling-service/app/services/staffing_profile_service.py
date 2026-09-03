"""CRUD for named, reusable coverage-requirement bundles — see
`StaffingProfile`'s own doc comment (`app/db/models.py`) for what this is
and isn't used for."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.schemas import StaffingProfileEntryInput
from app.core.errors import DomainError
from app.db.models import StaffingProfile


class StaffingProfileNotFoundError(DomainError):
    code = "STAFFING_PROFILE_NOT_FOUND"
    http_status = 404

    def __init__(self, profile_id: uuid.UUID) -> None:
        super().__init__(f"Staffing profile {profile_id} not found.")


def _entries_to_json(entries: list[StaffingProfileEntryInput]) -> list[dict[str, Any]]:
    return [
        {"shiftTemplateId": str(e.shift_template_id), "requiredHeadcount": e.required_headcount}
        for e in entries
    ]


async def create_staffing_profile(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    entries: list[StaffingProfileEntryInput],
) -> StaffingProfile:
    now = datetime.now(UTC)
    row = StaffingProfile(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        entries=_entries_to_json(entries),
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_staffing_profiles(session: AsyncSession, *, tenant_id: uuid.UUID) -> list[StaffingProfile]:
    stmt = (
        select(StaffingProfile).where(StaffingProfile.tenant_id == tenant_id).order_by(StaffingProfile.name)
    )
    return list((await session.scalars(stmt)).all())


async def delete_staffing_profile(
    session: AsyncSession, *, tenant_id: uuid.UUID, profile_id: uuid.UUID
) -> None:
    await session.execute(
        delete(StaffingProfile).where(
            StaffingProfile.tenant_id == tenant_id, StaffingProfile.id == profile_id
        )
    )


async def update_staffing_profile(
    session: AsyncSession, *, tenant_id: uuid.UUID, profile_id: uuid.UUID, **fields: Any
) -> StaffingProfile:
    """Applies only the keys present in `fields` (the router passes
    `StaffingProfileUpdate.model_dump(exclude_unset=True)`) — a key simply
    absent from the caller's request body is left untouched."""
    row = (
        await session.scalars(
            select(StaffingProfile).where(
                StaffingProfile.tenant_id == tenant_id, StaffingProfile.id == profile_id
            )
        )
    ).first()
    if row is None:
        raise StaffingProfileNotFoundError(profile_id)

    if "entries" in fields and fields["entries"] is not None:
        fields["entries"] = _entries_to_json(fields["entries"])

    for key, value in fields.items():
        setattr(row, key, value)

    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row
