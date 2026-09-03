"""Exercises `TenantContextMiddleware`/`RequestIdMiddleware` in isolation, on
a minimal app rather than `app.main.app` - the real app's lifespan opens a
NATS connection and a DB engine, neither available in a unit-test
environment (that's what tests/integration/ is for). No database, no NATS.

GAP-08 fix (enterprise readiness audit, 2026-08-18): this middleware used to
trust a raw `X-Tenant-Id` header outright - these tests now exercise real
JWT verification (`tests/jwt_test_helpers.py` signs real tokens and
monkeypatches the JWKS resolution step only, not the verification logic
itself).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import get_settings
from app.core.middleware import TenantContextMiddleware
from app.core.request_id import REQUEST_ID_HEADER, RequestIdMiddleware
from app.core.tenant_context import get_current
from tests.jwt_test_helpers import (
    auth_headers,
    default_claims,
    make_bearer_token,
    make_token_with_claims,
    make_token_with_wrong_key,
)

test_app = FastAPI()
test_app.add_middleware(TenantContextMiddleware)
test_app.add_middleware(RequestIdMiddleware)


@test_app.get("/whoami")
def whoami() -> dict[str, str | None]:
    context = get_current()
    return {"tenant_id": context.tenant_id if context else None}


client = TestClient(test_app)


def test_missing_authorization_header_is_rejected() -> None:
    """Unlike the old raw-header placeholder (which let an unauthenticated
    request through with no context bound), a request with no bearer token
    at all is now rejected outright - there is no legitimate "no auth"
    request against a tenant-scoped route."""
    response = client.get("/whoami")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"


def test_malformed_authorization_header_is_rejected() -> None:
    response = client.get("/whoami", headers={"Authorization": "not-a-bearer-token"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"


def test_valid_bearer_token_binds_tenant_context_from_verified_claims() -> None:
    tenant_id = "11111111-1111-1111-1111-111111111111"
    response = client.get("/whoami", headers=auth_headers(tenant_id))
    assert response.status_code == 200
    assert response.json() == {"tenant_id": tenant_id}


def test_token_with_bad_signature_is_rejected() -> None:
    """A token signed with a *different* key than the one `_patch_jwks_client`
    resolves to - proves signature verification is real, not a formality."""
    token = make_token_with_wrong_key(
        default_claims("11111111-1111-1111-1111-111111111111", "actor-1")
    )
    response = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"


def test_token_with_malformed_tenant_id_claim_returns_invalid_authentication() -> None:
    token = make_bearer_token("not-a-uuid")
    response = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "INVALID_AUTHENTICATION"


def test_token_missing_tenant_id_claim_is_rejected() -> None:
    settings = get_settings()
    now = datetime.now(UTC)
    claims = {
        "sub": "actor-1",
        "iss": settings.oidc_issuer,
        "aud": settings.oidc_audience,
        "iat": now,
        "exp": now + timedelta(minutes=10),
    }
    token = make_token_with_claims(claims)
    response = client.get("/whoami", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"


def test_healthz_and_metrics_are_reachable_without_a_token() -> None:
    """`_UNVERIFIED_ROUTES` - infra liveness/scrape endpoints carry no
    tenant-scoped data and must stay reachable without a token."""

    @test_app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    response = client.get("/healthz")
    assert response.status_code == 200


def test_request_id_is_generated_when_absent() -> None:
    response = client.get("/whoami", headers=auth_headers("11111111-1111-1111-1111-111111111111"))
    assert REQUEST_ID_HEADER in response.headers
    assert len(response.headers[REQUEST_ID_HEADER]) > 0


def test_request_id_is_echoed_when_provided() -> None:
    headers = {
        **auth_headers("11111111-1111-1111-1111-111111111111"),
        REQUEST_ID_HEADER: "caller-supplied-id",
    }
    response = client.get("/whoami", headers=headers)
    assert response.headers[REQUEST_ID_HEADER] == "caller-supplied-id"
