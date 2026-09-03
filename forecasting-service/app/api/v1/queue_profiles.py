"""ADR-0020's cold-start similarity metadata endpoint - tenant-scoped,
low-stakes queue metadata (industry/queue type/volume band/timezone bucket),
not gated the way `tenant_settings` is."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import QueueProfileRequest, QueueProfileResponse
from app.core.tenant_context import TenantContext
from app.db.models import QueueProfile

router = APIRouter(prefix="/v1/forecasting/queue-profiles", tags=["forecasting-queue-profiles"])


def _to_response(row: QueueProfile) -> QueueProfileResponse:
    return QueueProfileResponse(
        org_unit_id=row.org_unit_id,
        industry=row.industry,
        queue_type=row.queue_type,
        expected_volume_band=row.expected_volume_band,
        timezone_bucket=row.timezone_bucket,
    )


@router.get("", response_model=list[QueueProfileResponse])
async def list_queue_profiles(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[QueueProfileResponse]:
    tenant_id = uuid.UUID(context.tenant_id)
    rows = await session.scalars(
        select(QueueProfile).where(QueueProfile.tenant_id == tenant_id).order_by(QueueProfile.queue_type)
    )
    return [_to_response(row) for row in rows]


@router.put("/{org_unit_id}", response_model=QueueProfileResponse)
async def upsert_queue_profile(
    org_unit_id: uuid.UUID,
    body: QueueProfileRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> QueueProfileResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    now = datetime.now(UTC)
    stmt = pg_insert(QueueProfile).values(
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        industry=body.industry,
        queue_type=body.queue_type,
        expected_volume_band=body.expected_volume_band,
        timezone_bucket=body.timezone_bucket,
        created_at=now,
        updated_at=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["tenant_id", "org_unit_id"],
        set_={
            "industry": stmt.excluded.industry,
            "queue_type": stmt.excluded.queue_type,
            "expected_volume_band": stmt.excluded.expected_volume_band,
            "timezone_bucket": stmt.excluded.timezone_bucket,
        },
    )
    await session.execute(stmt)
    return QueueProfileResponse(org_unit_id=org_unit_id, **body.model_dump())
