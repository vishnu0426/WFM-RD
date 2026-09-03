"""CRUD for `Campaign` and its `CampaignQueue` assignments — see their own
doc comments (`app/db/models.py`) for what these are and aren't."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import CampaignNotFoundError
from app.db.models import Campaign, CampaignQueue


async def create_campaign(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    name: str,
    description: str | None,
    status: str,
    start_date: date | None,
    end_date: date | None,
    time_zone: str | None = None,
    week_start_day: str | None = None,
    day_boundary: time | None = None,
    is_distributed_campaign: bool = False,
    scheduling_period: str | None = None,
) -> Campaign:
    now = datetime.now(UTC)
    row = Campaign(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        description=description,
        status=status,
        start_date=start_date,
        end_date=end_date,
        time_zone=time_zone,
        week_start_day=week_start_day,
        day_boundary=day_boundary,
        is_distributed_campaign=is_distributed_campaign,
        scheduling_period=scheduling_period,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_campaigns(session: AsyncSession, *, tenant_id: uuid.UUID) -> list[Campaign]:
    stmt = select(Campaign).where(Campaign.tenant_id == tenant_id).order_by(Campaign.created_at.desc())
    return list((await session.scalars(stmt)).all())


async def update_campaign(
    session: AsyncSession, *, tenant_id: uuid.UUID, campaign_id: uuid.UUID, updates: dict[str, object]
) -> Campaign:
    row = await session.scalar(
        select(Campaign).where(Campaign.tenant_id == tenant_id, Campaign.id == campaign_id)
    )
    if row is None:
        raise CampaignNotFoundError(campaign_id)
    for field, value in updates.items():
        setattr(row, field, value)
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row


async def delete_campaign(session: AsyncSession, *, tenant_id: uuid.UUID, campaign_id: uuid.UUID) -> None:
    await session.execute(delete(Campaign).where(Campaign.tenant_id == tenant_id, Campaign.id == campaign_id))


async def add_campaign_queue(
    session: AsyncSession, *, tenant_id: uuid.UUID, campaign_id: uuid.UUID, org_unit_id: uuid.UUID
) -> CampaignQueue:
    stmt = (
        pg_insert(CampaignQueue)
        .values(
            tenant_id=tenant_id,
            campaign_id=campaign_id,
            org_unit_id=org_unit_id,
            added_at=datetime.now(UTC),
        )
        .on_conflict_do_nothing(index_elements=["tenant_id", "campaign_id", "org_unit_id"])
        .returning(CampaignQueue)
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is not None:
        return row
    # Already assigned - conflict was a no-op, so fetch the existing row.
    existing = await session.scalar(
        select(CampaignQueue).where(
            CampaignQueue.tenant_id == tenant_id,
            CampaignQueue.campaign_id == campaign_id,
            CampaignQueue.org_unit_id == org_unit_id,
        )
    )
    assert existing is not None
    return existing


async def list_campaign_queues(
    session: AsyncSession, *, tenant_id: uuid.UUID, campaign_id: uuid.UUID
) -> list[CampaignQueue]:
    stmt = (
        select(CampaignQueue)
        .where(CampaignQueue.tenant_id == tenant_id, CampaignQueue.campaign_id == campaign_id)
        .order_by(CampaignQueue.added_at)
    )
    return list((await session.scalars(stmt)).all())


async def remove_campaign_queue(
    session: AsyncSession, *, tenant_id: uuid.UUID, campaign_id: uuid.UUID, org_unit_id: uuid.UUID
) -> None:
    await session.execute(
        delete(CampaignQueue).where(
            CampaignQueue.tenant_id == tenant_id,
            CampaignQueue.campaign_id == campaign_id,
            CampaignQueue.org_unit_id == org_unit_id,
        )
    )
