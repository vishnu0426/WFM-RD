"""ADR-0023's `service_level_targets` endpoint - tenant-scoped business
configuration (not admin-gated, unlike `tenant_settings`)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import ServiceLevelTargetRequest, ServiceLevelTargetResponse
from app.core.tenant_context import TenantContext
from app.db.models import ServiceLevelTarget
from app.services import headcount_service

router = APIRouter(prefix="/v1/forecasting/service-level-targets", tags=["forecasting-service-level-targets"])


@router.get("/{org_unit_id}", response_model=ServiceLevelTargetResponse)
async def get_service_level_target(
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ServiceLevelTargetResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    row = await session.scalar(
        select(ServiceLevelTarget).where(
            ServiceLevelTarget.tenant_id == tenant_id, ServiceLevelTarget.org_unit_id == org_unit_id
        )
    )
    if row is None:
        # Platform defaults (ADR-0023, Decision 3) - not a 404. A tenant
        # that never configured this still gets a real, usable answer.
        return ServiceLevelTargetResponse(
            org_unit_id=org_unit_id,
            target_service_level=Decimal(str(headcount_service.DEFAULT_TARGET_SERVICE_LEVEL)),
            target_answer_time_seconds=headcount_service.DEFAULT_TARGET_ANSWER_TIME_SECONDS,
            max_occupancy=Decimal(str(headcount_service.DEFAULT_MAX_OCCUPANCY)),
            is_default=True,
        )
    return ServiceLevelTargetResponse(
        org_unit_id=org_unit_id,
        target_service_level=row.target_service_level,
        target_answer_time_seconds=row.target_answer_time_seconds,
        max_occupancy=row.max_occupancy,
        is_default=False,
    )


@router.put("/{org_unit_id}", response_model=ServiceLevelTargetResponse)
async def upsert_service_level_target(
    org_unit_id: uuid.UUID,
    body: ServiceLevelTargetRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ServiceLevelTargetResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    now = datetime.now(UTC)
    stmt = pg_insert(ServiceLevelTarget).values(
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        target_service_level=body.target_service_level,
        target_answer_time_seconds=body.target_answer_time_seconds,
        max_occupancy=body.max_occupancy,
        created_at=now,
        updated_at=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["tenant_id", "org_unit_id"],
        set_={
            "target_service_level": stmt.excluded.target_service_level,
            "target_answer_time_seconds": stmt.excluded.target_answer_time_seconds,
            "max_occupancy": stmt.excluded.max_occupancy,
        },
    )
    await session.execute(stmt)
    return ServiceLevelTargetResponse(org_unit_id=org_unit_id, is_default=False, **body.model_dump())
