"""ADR-0026, Decision 7 - liveness/readiness split mirroring Module 01's
`/healthz`/`/readyz` (`src/common/health/health.controller.ts`). `/healthz`
never touches a dependency - it answers "is this process running at all."
`/readyz` checks Postgres (a blocking dependency - failure flips the
response to 503, mirroring Module 01's own Postgres check) and NATS
(reported but non-blocking, mirroring Module 01's identical treatment of
Redis: "degrades latency, not availability" - a publish failure here
doesn't block a job's own DB-persisted completion, so it isn't this
service's definition of "unavailable" either).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db.session import get_engine

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    checks: dict[str, str] = {}
    ready = True

    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception as exc:  # noqa: BLE001 - reported in the body, not re-raised
        checks["postgres"] = f"unreachable: {exc}"
        ready = False

    nats_connection: Any = getattr(request.app.state, "nats_connection", None)
    if nats_connection is not None and getattr(nats_connection, "is_connected", False):
        checks["nats"] = "ok"
    else:
        checks["nats"] = "unreachable"

    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ok" if ready else "degraded", "checks": checks},
    )
