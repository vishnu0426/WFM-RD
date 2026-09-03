"""ADR-0026, Decision 5's `tenant_settings` write path - closing ADR-0020
Gap 2's stated "no admin API" gap. Platform-admin-gated
(`require_platform_admin`), not a self-service endpoint - `tft_entitled`
is a billing/entitlement decision, not tenant configuration."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, require_platform_admin
from app.api.v1.schemas import TenantSettingsRequest, TenantSettingsResponse
from app.core.tenant_context import TenantContext
from app.db.models import TenantSettings

router = APIRouter(prefix="/v1/forecasting/admin", tags=["forecasting-admin"])


@router.put("/tenant-settings", response_model=TenantSettingsResponse)
async def upsert_tenant_settings(
    body: TenantSettingsRequest,
    context: TenantContext = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_db_session),
) -> TenantSettingsResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    now = datetime.now(UTC)
    stmt = pg_insert(TenantSettings).values(
        tenant_id=tenant_id,
        tft_entitled=body.tft_entitled,
        cold_start_cross_tenant_matching_enabled=body.cold_start_cross_tenant_matching_enabled,
        created_at=now,
        updated_at=now,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["tenant_id"],
        set_={
            "tft_entitled": stmt.excluded.tft_entitled,
            "cold_start_cross_tenant_matching_enabled": (
                stmt.excluded.cold_start_cross_tenant_matching_enabled
            ),
        },
    )
    await session.execute(stmt)
    return TenantSettingsResponse(tenant_id=tenant_id, **body.model_dump())
