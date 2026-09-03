"""Requires a reachable Postgres with the Phase 1 migration already applied
(`docker-compose up -d && alembic upgrade head`, run from
`scheduling-service/`) and a reachable NATS - same "requires the steps above"
posture as Module 01/02/03's integration suites, not testcontainers.

Phase 7 (ADR-0060): every `POST` that used to solve synchronously now only
enqueues - a real `app/worker.py` process is what actually processes a job.
`_run_worker` (session-scoped, autouse) launches exactly that as a real
subprocess for the whole test session, the same topology a real deployment
uses (a separate OS process, not something the test's own event loop drives
directly) rather than calling `job_service.execute_job` in-process, which
would prove the solving logic but not the actual claim/queue mechanics
(`SELECT ... FOR UPDATE SKIP LOCKED`, the platform-admin RLS bypass) at all.
`poll_until_terminal` is how every test waits for a job's real outcome.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from tests.jwt_test_helpers import (  # noqa: F401 - `_patch_jwks_client` is an autouse fixture, not called directly
    _patch_jwks_client,
    auth_headers,
)


def _url(username: str, password_env: str, default_password: str) -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv(password_env, default_password)
    return f"postgresql+asyncpg://{username}:{password}@{host}:{port}/{database}"


@pytest.fixture(scope="session", autouse=True)
def _run_worker() -> AsyncIterator[None]:  # type: ignore[misc]
    """A real `python -m app.worker` subprocess, for the whole test
    session - one worker is enough concurrency for this suite's own job
    volume; tests needing to prove multi-worker claim semantics
    specifically start their own additional instance (see
    `test_worker_and_reaper.py`)."""
    env = {
        **os.environ,
        "WORKER_POLL_INTERVAL_SECONDS": "0.2",
        "WORKER_METRICS_PORT": "8199",  # a dedicated port for this session-scoped worker specifically
    }
    proc = subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", "app.worker"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)  # let it connect to Postgres/NATS and start polling before any test submits a job
    try:
        yield
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def poll_until_terminal(
    client: TestClient, tenant_id: uuid.UUID, job_id: str, *, timeout: float = 10.0
) -> dict[str, object]:
    """Every Phase 7+ test's own replacement for asserting a `POST`
    response's `status` directly - `POST` now only ever returns `queued`.
    Polls `GET /v1/scheduling/jobs/{jobId}` until `status` leaves
    `queued`/`solving`; a job still non-terminal after `timeout` is a real,
    actionable test failure (the worker isn't running, or is stuck), not
    something to retry away."""
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_id))
        assert response.status_code == 200, response.text
        last = response.json()
        if last["status"] not in ("queued", "solving"):
            return last
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not reach a terminal status within {timeout}s: {last}")


@pytest_asyncio.fixture
async def app_engine() -> AsyncIterator[AsyncEngine]:
    """Function-scoped, not session-scoped: pytest-asyncio gives each async
    test its own event loop by default, and an `AsyncEngine`'s connection
    pool is bound to whichever loop was running when it was created - a
    session-scoped engine reused across tests in different loops surfaces as
    `InterfaceError`/`RuntimeError: Event loop is closed` (same lesson Module
    03's own conftest documents having hit for real)."""
    engine = create_async_engine(_url("agno_scheduling_app", "DB_PASSWORD", "changeme_local_only"))
    yield engine
    await engine.dispose()


@pytest.fixture
def tenant_a_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def tenant_b_id() -> uuid.UUID:
    return uuid.uuid4()
