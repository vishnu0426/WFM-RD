"""Reusable shift-template CRUD ("Shifts" in the reference console's own
menu). See `ShiftTemplate`'s own doc comment (`app/db/models.py`) for what
this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import ShiftTemplateRequest, ShiftTemplateResponse, ShiftTemplateUpdate
from app.core.tenant_context import TenantContext
from app.db.models import ShiftTemplate
from app.services import shift_template_service

router = APIRouter(prefix="/v1/scheduling/shift-templates", tags=["scheduling-shift-templates"])


def _to_response(row: ShiftTemplate) -> ShiftTemplateResponse:
    return ShiftTemplateResponse(
        id=row.id,
        name=row.name,
        start_time=row.start_time.strftime("%H:%M"),
        end_time=row.end_time.strftime("%H:%M"),
        break_minutes=row.break_minutes,
        required_skill_id=row.required_skill_id,
        default_headcount=row.default_headcount,
    )


@router.post("", response_model=ShiftTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_shift_template(
    body: ShiftTemplateRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ShiftTemplateResponse:
    row = await shift_template_service.create_shift_template(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        name=body.name,
        start_time=body.start_time,
        end_time=body.end_time,
        break_minutes=body.break_minutes,
        required_skill_id=body.required_skill_id,
        default_headcount=body.default_headcount,
    )
    return _to_response(row)


@router.get("", response_model=list[ShiftTemplateResponse])
async def list_shift_templates(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ShiftTemplateResponse]:
    rows = await shift_template_service.list_shift_templates(session, tenant_id=uuid.UUID(context.tenant_id))
    return [_to_response(row) for row in rows]


@router.patch("/{template_id}", response_model=ShiftTemplateResponse)
async def update_shift_template(
    template_id: uuid.UUID,
    body: ShiftTemplateUpdate,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ShiftTemplateResponse:
    row = await shift_template_service.update_shift_template(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        template_id=template_id,
        **body.model_dump(exclude_unset=True),
    )
    return _to_response(row)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_shift_template(
    template_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await shift_template_service.delete_shift_template(
        session, tenant_id=uuid.UUID(context.tenant_id), template_id=template_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
