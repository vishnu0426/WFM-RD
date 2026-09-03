"""`headcount_allocations` endpoint - splits an org unit's required headcount
(from `service_level_targets` + the forecast) across skills."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import AllocationEntry, AllocationsResponse, ReplaceAllocationsRequest
from app.core.tenant_context import TenantContext
from app.db.models import HeadcountAllocation

router = APIRouter(prefix="/v1/forecasting/allocations", tags=["forecasting-allocations"])


@router.get("/{org_unit_id}", response_model=AllocationsResponse)
async def list_allocations(
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> AllocationsResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    rows = await session.scalars(
        select(HeadcountAllocation).where(
            HeadcountAllocation.tenant_id == tenant_id, HeadcountAllocation.org_unit_id == org_unit_id
        )
    )
    return AllocationsResponse(
        org_unit_id=org_unit_id,
        allocations=[
            AllocationEntry(skill_id=row.skill_id, allocation_percentage=row.allocation_percentage)
            for row in rows
        ],
    )


@router.put("/{org_unit_id}", response_model=AllocationsResponse)
async def replace_allocations(
    org_unit_id: uuid.UUID,
    body: ReplaceAllocationsRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> AllocationsResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    now = datetime.now(UTC)
    # Full-set replace, not per-row upsert - the sum-to-100% invariant only
    # holds across the whole set, so a partial update could leave a
    # transiently-invalid (or silently stale) row behind.
    await session.execute(
        delete(HeadcountAllocation).where(
            HeadcountAllocation.tenant_id == tenant_id, HeadcountAllocation.org_unit_id == org_unit_id
        )
    )
    session.add_all(
        [
            HeadcountAllocation(
                tenant_id=tenant_id,
                org_unit_id=org_unit_id,
                skill_id=entry.skill_id,
                allocation_percentage=entry.allocation_percentage,
                created_at=now,
                updated_at=now,
            )
            for entry in body.allocations
        ]
    )
    return AllocationsResponse(org_unit_id=org_unit_id, allocations=body.allocations)
