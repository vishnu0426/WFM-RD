""""Campaigns" CRUD plus its nested "Queues" assignment endpoints
(reference console's own menu: Campaigns > Settings, Campaigns > Queues).
See `Campaign`/`CampaignQueue`'s own doc comments (`app/db/models.py`) for
what these are and aren't.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    AddCampaignQueueRequest,
    CampaignQueueResponse,
    CampaignRequest,
    CampaignResponse,
    CampaignUpdateRequest,
)
from app.core.tenant_context import TenantContext
from app.db.models import Campaign, CampaignQueue
from app.services import campaign_service

router = APIRouter(prefix="/v1/forecasting/campaigns", tags=["forecasting-campaigns"])


def _to_response(row: Campaign) -> CampaignResponse:
    return CampaignResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        status=row.status,
        start_date=row.start_date,
        end_date=row.end_date,
        time_zone=row.time_zone,
        week_start_day=row.week_start_day,
        day_boundary=row.day_boundary,
        is_distributed_campaign=row.is_distributed_campaign,
        scheduling_period=row.scheduling_period,
    )


def _queue_to_response(row: CampaignQueue) -> CampaignQueueResponse:
    return CampaignQueueResponse(org_unit_id=row.org_unit_id, added_at=row.added_at)


@router.post("", response_model=CampaignResponse, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: CampaignRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CampaignResponse:
    row = await campaign_service.create_campaign(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        name=body.name,
        description=body.description,
        status=body.status,
        start_date=body.start_date,
        end_date=body.end_date,
        time_zone=body.time_zone,
        week_start_day=body.week_start_day,
        day_boundary=body.day_boundary,
        is_distributed_campaign=body.is_distributed_campaign,
        scheduling_period=body.scheduling_period,
    )
    return _to_response(row)


@router.get("", response_model=list[CampaignResponse])
async def list_campaigns(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[CampaignResponse]:
    rows = await campaign_service.list_campaigns(session, tenant_id=uuid.UUID(context.tenant_id))
    return [_to_response(row) for row in rows]


@router.patch("/{campaign_id}", response_model=CampaignResponse)
async def update_campaign(
    campaign_id: uuid.UUID,
    body: CampaignUpdateRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CampaignResponse:
    updates = body.model_dump(exclude_unset=True)
    row = await campaign_service.update_campaign(
        session, tenant_id=uuid.UUID(context.tenant_id), campaign_id=campaign_id, updates=updates
    )
    return _to_response(row)


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign(
    campaign_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await campaign_service.delete_campaign(
        session, tenant_id=uuid.UUID(context.tenant_id), campaign_id=campaign_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{campaign_id}/queues", response_model=list[CampaignQueueResponse])
async def list_campaign_queues(
    campaign_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[CampaignQueueResponse]:
    rows = await campaign_service.list_campaign_queues(
        session, tenant_id=uuid.UUID(context.tenant_id), campaign_id=campaign_id
    )
    return [_queue_to_response(row) for row in rows]


@router.post(
    "/{campaign_id}/queues", response_model=CampaignQueueResponse, status_code=status.HTTP_201_CREATED
)
async def add_campaign_queue(
    campaign_id: uuid.UUID,
    body: AddCampaignQueueRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> CampaignQueueResponse:
    row = await campaign_service.add_campaign_queue(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        campaign_id=campaign_id,
        org_unit_id=body.org_unit_id,
    )
    return _queue_to_response(row)


@router.delete("/{campaign_id}/queues/{org_unit_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_campaign_queue(
    campaign_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await campaign_service.remove_campaign_queue(
        session, tenant_id=uuid.UUID(context.tenant_id), campaign_id=campaign_id, org_unit_id=org_unit_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
