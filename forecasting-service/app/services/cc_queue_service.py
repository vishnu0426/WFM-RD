"""CRUD for `CcQueue` - see its own doc comment (`app/db/models.py`) for
what this is and how it relates to `QueueProfile`/`service_level_targets`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import CcQueueNotFoundError
from app.db.models import CcQueue


async def create_cc_queue(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    external_queue_id: str,
    name: str,
    acd_provider: str | None,
    channel: str,
    routing_config: dict[str, object],
    status: str,
) -> CcQueue:
    now = datetime.now(UTC)
    row = CcQueue(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        external_queue_id=external_queue_id,
        acd_provider=acd_provider,
        name=name,
        channel=channel,
        routing_config=routing_config,
        status=status,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.flush()
    return row


async def list_cc_queues(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID | None = None
) -> list[CcQueue]:
    stmt = select(CcQueue).where(CcQueue.tenant_id == tenant_id)
    if org_unit_id is not None:
        stmt = stmt.where(CcQueue.org_unit_id == org_unit_id)
    stmt = stmt.order_by(CcQueue.created_at.desc())
    return list((await session.scalars(stmt)).all())


async def get_cc_queue(session: AsyncSession, *, tenant_id: uuid.UUID, queue_id: uuid.UUID) -> CcQueue:
    row = await session.scalar(select(CcQueue).where(CcQueue.tenant_id == tenant_id, CcQueue.id == queue_id))
    if row is None:
        raise CcQueueNotFoundError(str(queue_id))
    return row


async def get_cc_queue_by_external_id(
    session: AsyncSession, *, tenant_id: uuid.UUID, external_queue_id: str
) -> CcQueue:
    """The join point `intraday-service`/`integration-hub-service` are meant
    to call: their `queueId`/`ActivityEvent.queueId` is already this exact
    `external_queue_id` string, so no schema change is needed on their side
    to resolve it back to a tenant/org unit."""
    row = await session.scalar(
        select(CcQueue).where(CcQueue.tenant_id == tenant_id, CcQueue.external_queue_id == external_queue_id)
    )
    if row is None:
        raise CcQueueNotFoundError(external_queue_id)
    return row


async def update_cc_queue(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    queue_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    external_queue_id: str,
    name: str,
    acd_provider: str | None,
    channel: str,
    routing_config: dict[str, object],
    status: str,
) -> CcQueue:
    row = await get_cc_queue(session, tenant_id=tenant_id, queue_id=queue_id)
    row.org_unit_id = org_unit_id
    row.external_queue_id = external_queue_id
    row.name = name
    row.acd_provider = acd_provider
    row.channel = channel
    row.routing_config = routing_config
    row.status = status
    row.updated_at = datetime.now(UTC)
    await session.flush()
    return row


async def delete_cc_queue(session: AsyncSession, *, tenant_id: uuid.UUID, queue_id: uuid.UUID) -> None:
    await session.execute(delete(CcQueue).where(CcQueue.tenant_id == tenant_id, CcQueue.id == queue_id))
