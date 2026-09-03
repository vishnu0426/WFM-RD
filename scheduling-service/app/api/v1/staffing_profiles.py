"""Named, reusable coverage-requirement bundle CRUD ("Staffing Profiles"
under Scenarios in the reference console's own menu). See `StaffingProfile`'s
own doc comment (`app/db/models.py`) for what this is and isn't used for.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    StaffingProfileEntryInput,
    StaffingProfileRequest,
    StaffingProfileResponse,
    StaffingProfileUpdate,
)
from app.core.tenant_context import TenantContext
from app.db.models import StaffingProfile
from app.services import staffing_profile_service

router = APIRouter(prefix="/v1/scheduling/staffing-profiles", tags=["scheduling-staffing-profiles"])


def _to_response(row: StaffingProfile) -> StaffingProfileResponse:
    return StaffingProfileResponse(
        id=row.id,
        name=row.name,
        entries=[
            StaffingProfileEntryInput(
                shift_template_id=uuid.UUID(e["shiftTemplateId"]), required_headcount=e["requiredHeadcount"]
            )
            for e in row.entries
        ],
    )


@router.post("", response_model=StaffingProfileResponse, status_code=status.HTTP_201_CREATED)
async def create_staffing_profile(
    body: StaffingProfileRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> StaffingProfileResponse:
    row = await staffing_profile_service.create_staffing_profile(
        session, tenant_id=uuid.UUID(context.tenant_id), name=body.name, entries=body.entries
    )
    return _to_response(row)


@router.get("", response_model=list[StaffingProfileResponse])
async def list_staffing_profiles(
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[StaffingProfileResponse]:
    tenant_id = uuid.UUID(context.tenant_id)
    rows = await staffing_profile_service.list_staffing_profiles(session, tenant_id=tenant_id)
    return [_to_response(row) for row in rows]


@router.patch("/{profile_id}", response_model=StaffingProfileResponse)
async def update_staffing_profile(
    profile_id: uuid.UUID,
    body: StaffingProfileUpdate,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> StaffingProfileResponse:
    row = await staffing_profile_service.update_staffing_profile(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        profile_id=profile_id,
        **body.model_dump(exclude_unset=True),
    )
    return _to_response(row)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_staffing_profile(
    profile_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    await staffing_profile_service.delete_staffing_profile(
        session, tenant_id=uuid.UUID(context.tenant_id), profile_id=profile_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
