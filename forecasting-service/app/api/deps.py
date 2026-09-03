from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import PlatformAdminRequiredError
from app.core.tenant_context import TenantContext, require_current
from app.db.session import tenant_scoped_session


def get_tenant_context() -> TenantContext:
    """Fails closed (`TenantContextMissingError`) if `TenantContextMiddleware`
    never bound a context - i.e. the caller sent no `X-Tenant-Id` header."""
    return require_current()


def require_platform_admin(context: TenantContext = Depends(get_tenant_context)) -> TenantContext:
    """ADR-0026, Decision 5's admin gate - `X-Platform-Admin: true` plus a
    real `X-Tenant-Id` (still required; an admin action still targets one
    tenant's row, same as every other endpoint - there's no "no tenant"
    admin mode)."""
    if not context.is_platform_admin:
        raise PlatformAdminRequiredError()
    return context


async def get_db_session() -> AsyncIterator[AsyncSession]:
    context = get_tenant_context()
    async with tenant_scoped_session(context) as session:
        yield session


async def get_idempotency_key(idempotency_key: str = Header(..., alias="Idempotency-Key")) -> str:
    return idempotency_key
