"""ADR-0026, Decision 7 - `/healthz`/`/readyz`/`/metrics` against a real
Postgres + NATS (every integration test's lifespan already requires both
reachable to even construct `TestClient(app)` - see `app/main.py`'s
`lifespan`)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

pytestmark = pytest.mark.asyncio


async def test_healthz_is_always_ok() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readyz_reports_postgres_and_nats_as_ok() -> None:
    with TestClient(app) as client:
        response = client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"]["postgres"] == "ok"
    assert body["checks"]["nats"] == "ok"


async def test_metrics_exposes_prometheus_text_format_after_some_requests() -> None:
    with TestClient(app) as client:
        client.get("/healthz")
        client.get("/healthz")
        response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    body = response.text
    assert "http_requests_total" in body
    assert 'route="/healthz"' in body
