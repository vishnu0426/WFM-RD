"""End-to-end §3.3 contract test: `POST /v1/forecasting/jobs` then
`GET /v1/forecasting/jobs/{jobId}` against the real FastAPI app, a real
Postgres (Phase 1+2 migrations applied), and a real NATS. Python analogue of
`test/integration/org-api-http.spec.ts`.

Phase 2 (ADR-0020) wires the data-quality gate + cold-start fallback into
submission itself, so "submit a job for a brand-new org unit with zero
history" now has three distinct, separately-tested outcomes instead of
always succeeding at `status: queued` the way Phase 1 left it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastDataPoint
from app.db.session import tenant_scoped_session
from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


async def _get_data_points(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, forecast_run_id: uuid.UUID
) -> list[ForecastDataPoint]:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        return list(
            (
                await session.scalars(
                    select(ForecastDataPoint).where(
                        ForecastDataPoint.tenant_id == tenant_id,
                        ForecastDataPoint.forecast_run_id == forecast_run_id,
                    )
                )
            ).all()
        )


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _date_range(*, start_offset_days: int, span_days: int) -> tuple[str, str]:
    """Relative to today, not a hardcoded literal - `forecast_data_points`/
    `forecast_accuracy_log`/`historical_actuals` only have partitions for
    (bootstrap-migration-time month) +/- 1 (ADR-0005/0018/0020); a fixed
    date string silently drifts out of that window and starts failing with
    `no partition of relation ... found for row` once enough real time has
    passed since the migration was applied - found by actually running this
    suite against a real, already-migrated database, not warned about by
    any static check."""
    start = date.today() + timedelta(days=start_offset_days)
    end = start + timedelta(days=span_days)
    return start.isoformat(), end.isoformat()


def _generate_points(
    weeks: int, *, as_of: datetime, gap_ratio: float = 0.0
) -> list[dict[str, str]]:
    """9 weeks of clean half-hour actuals, by default with no gaps - enough
    to clear SARIMA's 8-week/5%-gap bar (ADR-0019)."""
    total_intervals = weeks * 7 * 24 * 60 // _INTERVAL_MINUTES
    points: list[dict[str, str]] = []
    for i in range(total_intervals):
        if gap_ratio and i % int(1 / gap_ratio) == 0:
            continue
        interval_start = as_of - timedelta(minutes=_INTERVAL_MINUTES * (total_intervals - i))
        points.append(
            {
                "intervalStart": interval_start.isoformat(),
                "actualVolume": "10.0",
                "actualAhtSeconds": "300.0",
                "actualShrinkagePct": "0.15",
            }
        )
    return points


def _seed_actuals(client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int) -> None:
    body = {"orgUnitId": str(org_unit_id), "points": _generate_points(weeks, as_of=datetime.now(UTC))}
    response = client.post(
        "/v1/forecasting/actuals", json=body, headers=auth_headers(tenant_id)
    )
    assert response.status_code == 200, response.text


def _seed_queue_profile(client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID) -> None:
    body = {
        "industry": "retail",
        "queueType": "inbound_support",
        "expectedVolumeBand": "m",
        "timezoneBucket": "utc-5",
    }
    response = client.put(
        f"/v1/forecasting/queue-profiles/{org_unit_id}", json=body, headers=auth_headers(tenant_id)
    )
    assert response.status_code == 200, response.text


def _job_body(org_unit_id: uuid.UUID, *, start: str, end: str) -> dict[str, object]:
    return {
        "orgUnitId": str(org_unit_id),
        "dateRange": {"start": start, "end": end},
        "intervalMinutes": _INTERVAL_MINUTES,
    }


async def test_submit_job_with_sufficient_history_is_queued_normally(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=27)
    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=9)

        submit_response = client.post(
            "/v1/forecasting/jobs",
            json=_job_body(org_unit_id, start=start, end=end),
            headers=_headers(tenant_a_id),
        )
        assert submit_response.status_code == 201
        assert submit_response.json()["status"] == "queued"

        job_id = submit_response.json()["jobId"]
        poll_response = client.get(
            f"/v1/forecasting/jobs/{job_id}", headers=auth_headers(tenant_a_id)
        )
        run = poll_response.json()
        assert run["status"] == "queued"
        assert run["isColdStart"] is False


async def test_submit_job_with_no_history_and_no_donors_returns_422(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=27)
    with TestClient(app) as client:
        response = client.post(
            "/v1/forecasting/jobs",
            json=_job_body(org_unit_id, start=start, end=end),
            headers=_headers(tenant_a_id),
        )

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "INSUFFICIENT_DATA"
    assert body["error"]["details"]["failureReason"] == "insufficient_history"


async def test_submit_job_with_no_history_but_a_similar_donor_seeds_cold_start(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID
) -> None:
    target_org_unit_id = uuid.uuid4()
    donor_org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=6)
    with TestClient(app) as client:
        _seed_queue_profile(client, tenant_a_id, target_org_unit_id)
        _seed_queue_profile(client, tenant_a_id, donor_org_unit_id)
        # Donor needs enough of a track record to be an eligible donor
        # (MIN_DONOR_WEEKS/MIN_DONOR_ROWS, ADR-0020) - it does NOT need to
        # clear the full SARIMA gate itself.
        _seed_actuals(client, tenant_a_id, donor_org_unit_id, weeks=3)

        response = client.post(
            "/v1/forecasting/jobs",
            json=_job_body(target_org_unit_id, start=start, end=end),
            headers=_headers(tenant_a_id),
        )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "completed"

    job_id = body["jobId"]
    with TestClient(app) as client:
        poll_response = client.get(
            f"/v1/forecasting/jobs/{job_id}", headers=auth_headers(tenant_a_id)
        )
    run = poll_response.json()
    assert run["isColdStart"] is True
    assert run["status"] == "completed"

    # Phase 5 (ADR-0023): required_headcount is computed via Erlang C using
    # the donor-averaged predicted_volume/AHT/shrinkage - not left NULL.
    points = await _get_data_points(app_engine, tenant_a_id, uuid.UUID(job_id))
    assert len(points) > 0
    assert any(point.required_headcount is not None for point in points)


async def test_same_idempotency_key_returns_the_same_run(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    headers = _headers(tenant_a_id)
    start, end = _date_range(start_offset_days=1, span_days=30)
    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=9)
        body = _job_body(org_unit_id, start=start, end=end)

        first = client.post("/v1/forecasting/jobs", json=body, headers=headers)
        second = client.post("/v1/forecasting/jobs", json=body, headers=headers)

    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["jobId"] == second.json()["jobId"]


async def test_a_tenant_cannot_poll_another_tenants_run(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=29)
    with TestClient(app) as client:
        _seed_actuals(client, tenant_a_id, org_unit_id, weeks=9)
        submit_response = client.post(
            "/v1/forecasting/jobs",
            json=_job_body(org_unit_id, start=start, end=end),
            headers=_headers(tenant_a_id),
        )
        job_id = submit_response.json()["jobId"]

        cross_tenant_response = client.get(
            f"/v1/forecasting/jobs/{job_id}", headers=auth_headers(tenant_b_id)
        )

    assert cross_tenant_response.status_code == 404
    assert cross_tenant_response.json()["error"]["code"] == "NOT_FOUND"


async def test_missing_bearer_token_fails_closed() -> None:
    """GAP-08 fix (enterprise readiness audit, 2026-08-18): a request with
    no `Authorization` header is now rejected by `TenantContextMiddleware`
    itself (401 INVALID_AUTHENTICATION), before this route's own
    `require_current()` call (400 TENANT_CONTEXT_MISSING) is ever reached -
    the old raw-header placeholder let an unauthenticated request through
    that far; real JWT verification does not."""
    with TestClient(app) as client:
        response = client.get(f"/v1/forecasting/jobs/{uuid.uuid4()}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"
