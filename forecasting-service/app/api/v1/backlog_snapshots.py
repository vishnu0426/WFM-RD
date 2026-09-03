""""Backlog Age" recording/history endpoints (reference console's own
menu). See `BacklogSnapshot`'s own doc comment (`app/db/models.py`) for
what this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import BacklogSnapshotResponse, RecordBacklogSnapshotRequest
from app.core.tenant_context import TenantContext
from app.db.models import BacklogSnapshot
from app.services import backlog_snapshot_service

router = APIRouter(prefix="/v1/forecasting/backlog-snapshots", tags=["forecasting-backlog-snapshots"])


def _to_response(row: BacklogSnapshot) -> BacklogSnapshotResponse:
    return BacklogSnapshotResponse(
        id=row.id,
        org_unit_id=row.org_unit_id,
        template_id=row.template_id,
        item_count=row.item_count,
        oldest_item_age_minutes=row.oldest_item_age_minutes,
        recorded_at=row.recorded_at,
    )


@router.post("", response_model=BacklogSnapshotResponse, status_code=status.HTTP_201_CREATED)
async def record_backlog_snapshot(
    body: RecordBacklogSnapshotRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> BacklogSnapshotResponse:
    row = await backlog_snapshot_service.record_backlog_snapshot(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=body.org_unit_id,
        template_id=body.template_id,
        item_count=body.item_count,
        oldest_item_age_minutes=body.oldest_item_age_minutes,
    )
    return _to_response(row)


@router.get("", response_model=list[BacklogSnapshotResponse])
async def list_backlog_snapshots(
    org_unit_id: uuid.UUID = Query(...),
    limit: int = Query(default=50, gt=0, le=500),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[BacklogSnapshotResponse]:
    rows = await backlog_snapshot_service.list_backlog_snapshots(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id, limit=limit
    )
    return [_to_response(row) for row in rows]
