"""GAP-08 fix (enterprise readiness audit, 2026-08-18): shared test-only JWT
signing + JWKS-bypass helpers, used by both `tests/unit/test_middleware.py`
and every `tests/integration/*` test that used to send a raw
`X-Tenant-Id`/`X-Actor-Id` header. Tests sign real JWTs with a throwaway
RSA keypair generated once at import time, then monkeypatch
`PyJWKClient.get_signing_key_from_jwt` to resolve to this keypair's public
half instead of making a real HTTP call to the root platform-core service's
JWKS endpoint - `JwtVerifier.verify`'s own signature/issuer/audience/expiry
logic runs completely unmodified against these tokens, so these tests still
exercise the real verification path, not a stand-in for it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt import PyJWKClient

from app.config import get_settings

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_KEY = _PRIVATE_KEY.public_key()


def make_token_with_claims(claims: dict[str, Any]) -> str:
    """The general form - callers own the entire claim set (e.g. a token
    deliberately missing `tenant_id`, to test that rejection path)."""
    return jwt.encode(claims, _PRIVATE_KEY, algorithm="RS256", headers={"kid": "test-key"})


def make_token_with_wrong_key(claims: dict[str, Any]) -> str:
    """Signed with a *different*, one-off key than `_patch_jwks_client`
    resolves to - for proving signature verification is real."""
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return jwt.encode(claims, wrong_key, algorithm="RS256", headers={"kid": "test-key"})


def default_claims(tenant_id: uuid.UUID | str, actor_id: str, **extra_claims: Any) -> dict[str, Any]:
    settings = get_settings()
    now = datetime.now(UTC)
    return {
        "sub": actor_id,
        "tenant_id": str(tenant_id),
        "iss": settings.oidc_issuer,
        "aud": settings.oidc_audience,
        "iat": now,
        "exp": now + timedelta(minutes=10),
        **extra_claims,
    }


def make_bearer_token(
    tenant_id: uuid.UUID | str,
    actor_id: str = "11111111-1111-1111-1111-111111111199",
    **extra_claims: Any,
) -> str:
    """A JWT shaped like `token.service.ts`'s real issuance (`sub`/`tenant_id`
    claims, real `iss`/`aud`/`exp`), signed with this module's throwaway
    test key - never a production key, never persisted."""
    return make_token_with_claims(default_claims(tenant_id, actor_id, **extra_claims))


def auth_headers(
    tenant_id: uuid.UUID | str,
    actor_id: str = "11111111-1111-1111-1111-111111111199",
    **extra_claims: Any,
) -> dict[str, str]:
    """`**extra_claims` covers e.g. `is_platform_admin=True` - GAP-08 fix:
    that flag (and `actor_type`) are now read from the *verified* JWT, not
    a raw `X-Platform-Admin` header, so a test that needs an admin-scoped
    request signs it into the token instead of setting that header."""
    return {"Authorization": f"Bearer {make_bearer_token(tenant_id, actor_id, **extra_claims)}"}


@pytest.fixture(autouse=True)
def _patch_jwks_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Autouse in every test file that imports this module - resolves any
    token's `kid` to this file's test public key rather than fetching a
    real JWKS over HTTP (no root platform-core service is running in these
    test environments)."""

    class _FakeSigningKey:
        def __init__(self) -> None:
            self.key = _PUBLIC_KEY

    monkeypatch.setattr(PyJWKClient, "get_signing_key_from_jwt", lambda self, token: _FakeSigningKey())
