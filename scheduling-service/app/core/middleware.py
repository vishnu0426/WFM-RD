"""GAP-08 fix (enterprise readiness audit, 2026-08-18): this middleware used
to trust the raw `X-Tenant-Id`/`X-Actor-Id`/`X-Actor-Type`/`X-Platform-Admin`
headers outright - a client could send any `X-Tenant-Id` it wanted, gated
only by network placement (the old placeholder's own doc comment said as
much). It now verifies a real `Authorization: Bearer <jwt>` against the root
platform-core service's JWKS (RS256 signature, issuer, audience, expiry -
`jwt_verifier.py`) and binds `tenant_id`/`actor_id`/`actor_type`/
`is_platform_admin` from the *verified* claims, never from a raw header -
the same trust boundary every Node service's `AccessTokenGuard` already
enforces (`src/modules/auth/services/token.service.ts` issues the `sub`/
`tenant_id` claims this middleware now reads), and the same fix
forecasting-service just applied to its own identical placeholder.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config import get_settings
from app.core.errors import DomainError, InvalidAuthenticationError
from app.core.jwt_verifier import JwtVerifier
from app.core.tenant_context import bind

_UNVERIFIED_ROUTES = frozenset({"/healthz", "/readyz", "/metrics"})
"""Same posture as every Node service's health/metrics endpoints - these
carry no tenant-scoped data and must stay reachable for infra liveness
checks/scraping without a token."""


class TenantContextMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)
        settings = get_settings()
        self._verifier = JwtVerifier(
            jwks_uri=settings.core_jwks_uri,
            issuer=settings.oidc_issuer,
            audience=settings.oidc_audience,
        )

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path in _UNVERIFIED_ROUTES:
            return await call_next(request)

        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            exc = InvalidAuthenticationError("missing or malformed Authorization header")
            return JSONResponse(status_code=exc.http_status, content=exc.to_envelope())

        token = auth_header.removeprefix("Bearer ").strip()
        try:
            context = self._verifier.verify(token)
        except InvalidAuthenticationError as exc:
            # Raised before the router (and its FastAPI exception handlers)
            # ever runs, so this middleware formats the envelope itself
            # rather than relying on `app.main`'s @exception_handler.
            return JSONResponse(status_code=exc.http_status, content=exc.to_envelope())

        with bind(context):
            return await call_next(request)


def domain_error_response(exc: DomainError) -> JSONResponse:
    return JSONResponse(status_code=exc.http_status, content=exc.to_envelope())
