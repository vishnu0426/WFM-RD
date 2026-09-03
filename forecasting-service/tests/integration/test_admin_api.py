"""ADR-0026, Decision 5's `tenant_settings` write path -
`PUT /v1/forecasting/admin/tenant-settings`, platform-admin-gated, closing
ADR-0020 Gap 2's stated "no admin API" gap for real against a real
Postgres.

GAP-08 fix (enterprise readiness audit, 2026-08-18): platform-admin status
used to be a raw `X-Platform-Admin: true` header (spoofable by any caller);
it's now the `is_platform_admin` claim on a *verified* JWT - `_headers`
signs it into the token via `auth_headers`'s `**extra_claims` rather than
setting a header the middleware no longer reads.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio


def _headers(tenant_id: uuid.UUID, *, is_admin: bool) -> dict[str, str]:
    return auth_headers(tenant_id, is_platform_admin=is_admin)


async def test_non_admin_request_is_rejected(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.put(
            "/v1/forecasting/admin/tenant-settings",
            json={"tftEntitled": True},
            headers=_headers(tenant_a_id, is_admin=False),
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PLATFORM_ADMIN_REQUIRED"


async def test_admin_request_upserts_tenant_settings(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.put(
            "/v1/forecasting/admin/tenant-settings",
            json={"tftEntitled": True, "coldStartCrossTenantMatchingEnabled": True},
            headers=_headers(tenant_a_id, is_admin=True),
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tenantId"] == str(tenant_a_id)
    assert body["tftEntitled"] is True
    assert body["coldStartCrossTenantMatchingEnabled"] is True


async def test_a_second_put_overwrites_rather_than_erroring(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        first = client.put(
            "/v1/forecasting/admin/tenant-settings",
            json={"tftEntitled": True},
            headers=_headers(tenant_a_id, is_admin=True),
        )
        second = client.put(
            "/v1/forecasting/admin/tenant-settings",
            json={"tftEntitled": False},
            headers=_headers(tenant_a_id, is_admin=True),
        )
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["tftEntitled"] is False


async def test_missing_bearer_token_fails_closed_before_the_admin_check_even_runs() -> None:
    """GAP-08 fix: platform-admin status only ever comes from a verified
    JWT claim now - there is no raw header path left to test "even for an
    admin header" against. A request with no token at all is rejected by
    `TenantContextMiddleware` itself, before this route's own
    `PlatformAdminRequiredError` check is ever reached."""
    with TestClient(app) as client:
        response = client.put(
            "/v1/forecasting/admin/tenant-settings",
            json={"tftEntitled": True},
        )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"
