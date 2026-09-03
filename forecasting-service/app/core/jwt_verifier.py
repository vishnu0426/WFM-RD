"""GAP-08 fix (enterprise readiness audit, 2026-08-18): real JWT
verification against the root platform-core service's JWKS, replacing
`TenantContextMiddleware`'s old raw-header trust. `PyJWKClient` fetches and
caches the JWKS (its own default in-memory cache, refetched on a signing-key
`kid` miss - the same "signing key rotated, JWKS refetched on demand" shape
Module 01's own `AccessTokenGuard` implementations use via `jose`'s remote
JWKS client).
"""

from __future__ import annotations

import jwt
from jwt import PyJWKClient

from app.core.errors import InvalidAuthenticationError
from app.core.tenant_context import TenantContext, parse_tenant_id


class JwtVerifier:
    def __init__(self, *, jwks_uri: str, issuer: str, audience: str) -> None:
        self._jwks_client = PyJWKClient(jwks_uri)
        self._issuer = issuer
        self._audience = audience

    def verify(self, token: str) -> TenantContext:
        """Verifies signature (RS256, via the JWKS-resolved public key
        matching the token's `kid`), issuer, audience, and expiry - then
        builds a `TenantContext` from the verified claims only.
        `tenant_id`/`sub` mirror `token.service.ts`'s issued shape exactly
        (`sub` = actor id, `tenant_id` = tenant id); `actor_type`/
        `is_platform_admin` are optional custom claims, defaulted rather
        than required, since not every token issuer sets them.
        """
        try:
            signing_key = self._jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                issuer=self._issuer,
                audience=self._audience,
            )
        except jwt.PyJWTError as exc:
            raise InvalidAuthenticationError(str(exc)) from exc

        raw_tenant_id = payload.get("tenant_id")
        if not raw_tenant_id:
            raise InvalidAuthenticationError("token has no tenant_id claim")
        try:
            # InvalidTenantIdError re-raised as an auth failure below - a
            # malformed claim on an otherwise-verified token is not a
            # client input-validation case.
            tenant_id = parse_tenant_id(str(raw_tenant_id))
        except Exception as exc:
            raise InvalidAuthenticationError("token tenant_id claim is not a valid tenant id") from exc

        actor_id = payload.get("sub")
        if not actor_id:
            raise InvalidAuthenticationError("token has no sub claim")

        return TenantContext(
            tenant_id=tenant_id,
            actor_id=str(actor_id),
            actor_type=payload.get("actor_type"),
            is_platform_admin=bool(payload.get("is_platform_admin", False)),
        )
