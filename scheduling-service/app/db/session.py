"""Python equivalent of `with-tenant-transaction.ts` (ADR-0002), reused
unchanged from Module 03's own copy: every request-scoped unit of work opens
one transaction and, as its *first* statement, binds
`app.current_tenant_id`/`app.is_platform_admin` via `set_config(..., true)`
(the `true` third argument is Postgres's "local to this transaction" flag).
Both values must already be validated/sourced from `TenantContext` - never
from client-supplied input beyond what `app/api/deps.py`'s placeholder
header-read already accepts (ADR-0014's same caveat applies here).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings, get_settings
from app.core.tenant_context import TenantContext

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine(settings: Settings | None = None) -> AsyncEngine:
    global _engine, _session_factory
    if _engine is None:
        settings = settings or get_settings()
        _engine = create_async_engine(settings.database_url, pool_pre_ping=True)
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    return _session_factory


async def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


@asynccontextmanager
async def tenant_scoped_session(
    context: TenantContext,
    *,
    session_factory: async_sessionmaker[AsyncSession] | None = None,
) -> AsyncIterator[AsyncSession]:
    """The only way application code should touch `scheduling.*` tables -
    mirrors `TenantScopedRepository` opening every query inside
    `withTenantTransaction`. Binds the GUCs, yields a session already inside
    an open transaction, commits on clean exit, rolls back on exception.

    `session_factory` defaults to the process-wide singleton
    (`get_session_factory()`); tests pass their own factory (bound to a
    test-scoped engine/fixture) instead of reaching into this module's
    private globals.
    """
    factory = session_factory or get_session_factory()
    async with factory() as session, session.begin():
        await session.execute(
            _SET_CONFIG_STMT,
            {
                "tenant_key": "app.current_tenant_id",
                "tenant_value": context.tenant_id,
                "admin_key": "app.is_platform_admin",
                "admin_value": "true" if context.is_platform_admin else "false",
            },
        )
        yield session


_SET_CONFIG_STMT = text(
    "SELECT set_config(:tenant_key, :tenant_value, true), "
    "set_config(:admin_key, :admin_value, true);"
)
