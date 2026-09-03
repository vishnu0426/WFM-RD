"""Reusable backlog-age-threshold CRUD ("Backlog Age Template" in the
reference console's own menu). See `BacklogAgeTemplate`'s own doc comment
(`app/db/models.py`) for what this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    BacklogAgeTemplateRequest,
    BacklogAgeTemplateResponse,
    BacklogAgeTemplateUpdateRequest,
)
from app.core.tenant_context import TenantContext
from app.db.models import BacklogAgeTemplate
from app.services import backlog_age_template_service

router = APIRouter(prefix="/v1/forecasting/backlog-age-templates", tags=["forecasting-backlog-age-templates"])


def _to_response(row: BacklogAgeTemplate) -> BacklogAgeTemplateResponse:
    return BacklogAgeTemplateResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        warning_threshold_minutes=row.warning_threshold_minutes,
        critical_threshold_minutes=row.critical_threshold_minutes,
    )


@router.post("", response_model=BacklogAgeTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_backlog_age_template(
    body: BacklogAgeTemplateRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> BacklogAgeTemplateResponse:
    row = await backlog_age_template_service.create_backlog_age_template(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        name=body.name,
        description=body.description,
        warning_threshold_minutes=body.warning_threshold_minutes,
        critical_threshold_minutes=body.critical_threshold_minutes,
    )
    return _to_response(row)


@router.get("", response_model=list[BacklogAgeTemplateResponse])
async def list_backlog_age_templates(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[BacklogAgeTemplateResponse]:
    rows = await backlog_age_template_service.list_backlog_age_templates(
        session, tenant_id=uuid.UUID(context.tenant_id)
    )
    return [_to_response(row) for row in rows]


@router.patch("/{template_id}", response_model=BacklogAgeTemplateResponse)
async def update_backlog_age_template(
    template_id: uuid.UUID,
    body: BacklogAgeTemplateUpdateRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> BacklogAgeTemplateResponse:
    updates = body.model_dump(exclude_unset=True)
    row = await backlog_age_template_service.update_backlog_age_template(
        session, tenant_id=uuid.UUID(context.tenant_id), template_id=template_id, updates=updates
    )
    return _to_response(row)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_backlog_age_template(
    template_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await backlog_age_template_service.delete_backlog_age_template(
        session, tenant_id=uuid.UUID(context.tenant_id), template_id=template_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
