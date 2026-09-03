"""Python analogue of Module 01's `TenantContextService` (ADR-0002), reused
unchanged from Module 03's own copy (`forecasting-service/app/core/
tenant_context.py`): `contextvars.ContextVar` is the async-safe equivalent of
Node's `AsyncLocalStorage` - a value bound for the duration of one
request/task and invisible to concurrent, unrelated requests. Same
fail-closed contract: nothing downstream can read a tenant id that wasn't
explicitly bound by whatever sits at the top of the call stack.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from app.core.errors import InvalidTenantIdError, TenantContextMissingError


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    actor_id: str | None = None
    actor_type: str | None = None
    is_platform_admin: bool = False


_current: ContextVar[TenantContext | None] = ContextVar("agno_tenant_context", default=None)


def platform_admin_context() -> TenantContext:
    """Phase 7 (ADR-0060): for platform-level background processes (the
    worker's cross-tenant `schedule_jobs` claim query) that act on behalf
    of no single tenant. `tenant_id` is a placeholder, deliberately the nil
    UUID so it reads as an obvious sentinel in logs rather than a stray
    real-looking id - the RLS policy this unlocks (`schedule_jobs` only,
    widened in migration 0004) keys off `is_platform_admin` alone via an
    `OR`, so the placeholder value is never actually compared against
    anything."""
    return TenantContext(tenant_id=str(uuid.UUID(int=0)), is_platform_admin=True)


def parse_tenant_id(raw_value: str) -> str:
    try:
        return str(uuid.UUID(raw_value))
    except ValueError as exc:
        raise InvalidTenantIdError(raw_value) from exc


@contextmanager
def bind(context: TenantContext) -> Iterator[None]:
    token = _current.set(context)
    try:
        yield
    finally:
        _current.reset(token)


def get_current() -> TenantContext | None:
    return _current.get()


def require_current() -> TenantContext:
    context = _current.get()
    if context is None:
        raise TenantContextMissingError()
    return context
