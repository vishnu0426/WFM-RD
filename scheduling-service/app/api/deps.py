from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Header, Request
from nats.js import JetStreamContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tenant_context import TenantContext, require_current
from app.db.session import tenant_scoped_session


def get_tenant_context() -> TenantContext:
    """Fails closed (`TenantContextMissingError`) if `TenantContextMiddleware`
    never bound a context - i.e. the caller sent no `X-Tenant-Id` header."""
    return require_current()


async def get_db_session() -> AsyncIterator[AsyncSession]:
    context = get_tenant_context()
    async with tenant_scoped_session(context) as session:
        yield session


async def get_idempotency_key(idempotency_key: str = Header(..., alias="Idempotency-Key")) -> str:
    return idempotency_key


def get_jetstream(request: Request) -> JetStreamContext:
    """§6/Phase 6's `agno.scheduling.job.completed.v1` publish trigger -
    `app.state.jetstream`, bound once at startup (`app/main.py`'s
    `lifespan`), the same connection every request reuses rather than
    opening a new one per publish."""
    jetstream: JetStreamContext = request.app.state.jetstream
    return jetstream
