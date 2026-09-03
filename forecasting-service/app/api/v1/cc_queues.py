""" "Contact Center Queues" - CRUD for `CcQueue`, the first-class mapping
from a raw ACD queue id to a tenant/org unit. See `CcQueue`'s own doc
comment (`app/db/models.py`) for why this exists alongside `QueueProfile`/
`campaign_queues`, which continue to key off `org_unit_id` directly, and for
what `/resolve/{external_queue_id}` is for."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import CcQueueRequest, CcQueueResponse
from app.core.tenant_context import TenantContext
from app.db.models import CcQueue
from app.services import cc_queue_service

router = APIRouter(prefix="/v1/forecasting/cc-queues", tags=["forecasting-cc-queues"])


def _to_response(row: CcQueue) -> CcQueueResponse:
    return CcQueueResponse(
        id=row.id,
        org_unit_id=row.org_unit_id,
        external_queue_id=row.external_queue_id,
        name=row.name,
        acd_provider=row.acd_provider,
        channel=row.channel,
        routing_config=row.routing_config,
        status=row.status,
    )


@router.post("", response_model=CcQueueResponse, status_code=status.HTTP_201_CREATED)
async def create_cc_queue(
    body: CcQueueRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CcQueueResponse:
    row = await cc_queue_service.create_cc_queue(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=body.org_unit_id,
        external_queue_id=body.external_queue_id,
        name=body.name,
        acd_provider=body.acd_provider,
        channel=body.channel,
        routing_config=body.routing_config,
        status=body.status,
    )
    return _to_response(row)


@router.get("", response_model=list[CcQueueResponse])
async def list_cc_queues(
    org_unit_id: uuid.UUID | None = Query(default=None),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[CcQueueResponse]:
    rows = await cc_queue_service.list_cc_queues(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id
    )
    return [_to_response(row) for row in rows]


@router.get("/resolve/{external_queue_id}", response_model=CcQueueResponse)
async def resolve_cc_queue(
    external_queue_id: str,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CcQueueResponse:
    row = await cc_queue_service.get_cc_queue_by_external_id(
        session, tenant_id=uuid.UUID(context.tenant_id), external_queue_id=external_queue_id
    )
    return _to_response(row)


@router.get("/{queue_id}", response_model=CcQueueResponse)
async def get_cc_queue(
    queue_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CcQueueResponse:
    row = await cc_queue_service.get_cc_queue(
        session, tenant_id=uuid.UUID(context.tenant_id), queue_id=queue_id
    )
    return _to_response(row)


@router.put("/{queue_id}", response_model=CcQueueResponse)
async def update_cc_queue(
    queue_id: uuid.UUID,
    body: CcQueueRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CcQueueResponse:
    row = await cc_queue_service.update_cc_queue(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        queue_id=queue_id,
        org_unit_id=body.org_unit_id,
        external_queue_id=body.external_queue_id,
        name=body.name,
        acd_provider=body.acd_provider,
        channel=body.channel,
        routing_config=body.routing_config,
        status=body.status,
    )
    return _to_response(row)


@router.delete("/{queue_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cc_queue(
    queue_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await cc_queue_service.delete_cc_queue(session, tenant_id=uuid.UUID(context.tenant_id), queue_id=queue_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
