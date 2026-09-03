"""Named recurring rotation cycle CRUD ("Work Patterns" in the reference
console's own menu). See `WorkPattern`'s own doc comment (`app/db/models.py`)
for what this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import WorkPatternRequest, WorkPatternResponse, WorkPatternUpdate
from app.core.tenant_context import TenantContext
from app.db.models import WorkPattern
from app.services import work_pattern_service

router = APIRouter(prefix="/v1/scheduling/work-patterns", tags=["scheduling-work-patterns"])


def _to_response(row: WorkPattern) -> WorkPatternResponse:
    return WorkPatternResponse(
        id=row.id,
        name=row.name,
        days=[uuid.UUID(d) if d is not None else None for d in row.days],
    )


@router.post("", response_model=WorkPatternResponse, status_code=status.HTTP_201_CREATED)
async def create_work_pattern(
    body: WorkPatternRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> WorkPatternResponse:
    row = await work_pattern_service.create_work_pattern(
        session, tenant_id=uuid.UUID(context.tenant_id), name=body.name, days=body.days
    )
    return _to_response(row)


@router.get("", response_model=list[WorkPatternResponse])
async def list_work_patterns(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[WorkPatternResponse]:
    rows = await work_pattern_service.list_work_patterns(session, tenant_id=uuid.UUID(context.tenant_id))
    return [_to_response(row) for row in rows]


@router.patch("/{pattern_id}", response_model=WorkPatternResponse)
async def update_work_pattern(
    pattern_id: uuid.UUID,
    body: WorkPatternUpdate,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> WorkPatternResponse:
    row = await work_pattern_service.update_work_pattern(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        pattern_id=pattern_id,
        **body.model_dump(exclude_unset=True),
    )
    return _to_response(row)


@router.delete("/{pattern_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_work_pattern(
    pattern_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await work_pattern_service.delete_work_pattern(
        session, tenant_id=uuid.UUID(context.tenant_id), pattern_id=pattern_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
