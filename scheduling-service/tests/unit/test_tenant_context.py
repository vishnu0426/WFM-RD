"""Python analogue of Module 01's `TenantContextService` unit tests, reused
unchanged from Module 03's own copy - fails closed with no bound context,
rejects malformed UUIDs, isolates concurrent async tasks. No database
required.
"""

from __future__ import annotations

import asyncio

import pytest

from app.core.errors import InvalidTenantIdError, TenantContextMissingError
from app.core.tenant_context import TenantContext, bind, get_current, parse_tenant_id, require_current


def test_require_current_fails_closed_with_no_bound_context() -> None:
    assert get_current() is None
    with pytest.raises(TenantContextMissingError):
        require_current()


def test_bind_makes_context_visible_and_resets_after() -> None:
    context = TenantContext(tenant_id="11111111-1111-1111-1111-111111111111")
    with bind(context):
        assert require_current() is context
    assert get_current() is None


def test_parse_tenant_id_rejects_malformed_uuid() -> None:
    with pytest.raises(InvalidTenantIdError):
        parse_tenant_id("not-a-uuid")


def test_parse_tenant_id_normalizes_valid_uuid() -> None:
    assert parse_tenant_id("11111111-1111-1111-1111-111111111111") == (
        "11111111-1111-1111-1111-111111111111"
    )


async def test_bind_isolates_concurrent_async_tasks() -> None:
    """The `contextvars` equivalent of Node's AsyncLocalStorage isolation
    guarantee: two concurrently-running tasks each bind their own tenant and
    must never observe the other's."""

    results: dict[str, str | None] = {}

    async def run_as(tenant_id: str, key: str, delay: float) -> None:
        with bind(TenantContext(tenant_id=tenant_id)):
            await asyncio.sleep(delay)
            results[key] = require_current().tenant_id

    await asyncio.gather(
        run_as("11111111-1111-1111-1111-111111111111", "a", 0.02),
        run_as("22222222-2222-2222-2222-222222222222", "b", 0.01),
    )

    assert results["a"] == "11111111-1111-1111-1111-111111111111"
    assert results["b"] == "22222222-2222-2222-2222-222222222222"
