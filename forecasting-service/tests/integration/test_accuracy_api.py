"""ADR-0025 Decision 1: `POST /v1/forecasting/actuals` auto-logs
`ForecastAccuracyLog` rows for any `completed` forecast run with a
prediction at a newly-ingested interval, is idempotent (never double-scores
the same interval), and the result is readable back via
`GET /v1/forecasting/accuracy/{orgUnitId}`."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _date_range(*, start_offset_days: int, span_days: int) -> tuple[str, str]:
    """Relative to today - see `test_jobs_api.py`'s identical helper for why
    (partition-window drift, ADR-0005/0018/0020)."""
    start = date.today() + timedelta(days=start_offset_days)
    end = start + timedelta(days=span_days)
    return start.isoformat(), end.isoformat()


def _generate_points(weeks: int, *, as_of: datetime) -> list[dict[str, str]]:
    total_intervals = weeks * 7 * 24 * 60 // _INTERVAL_MINUTES
    points: list[dict[str, str]] = []
    for i in range(total_intervals):
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


def _seed_actuals(
    client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int
) -> dict[str, object]:
    body = {"orgUnitId": str(org_unit_id), "points": _generate_points(weeks, as_of=datetime.now(UTC))}
    response = client.post("/v1/forecasting/actuals", json=body, headers=auth_headers(tenant_id))
    assert response.status_code == 200, response.text
    result: dict[str, object] = response.json()
    return result


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


def _cold_start_job(
    client: TestClient, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, *, start: str, end: str
) -> dict[str, object]:
    response = client.post(
        "/v1/forecasting/jobs",
        json={
            "orgUnitId": str(org_unit_id),
            "dateRange": {"start": start, "end": end},
            "intervalMinutes": _INTERVAL_MINUTES,
        },
        headers=_headers(tenant_id),
    )
    assert response.status_code == 201, response.text
    result: dict[str, object] = response.json()
    return result


async def test_ingesting_an_actual_at_a_forecasted_interval_logs_accuracy_and_it_is_queryable(
    tenant_a_id: uuid.UUID,
) -> None:
    target_org_unit_id = uuid.uuid4()
    donor_org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=1)

    with TestClient(app) as client:
        _seed_queue_profile(client, tenant_a_id, target_org_unit_id)
        _seed_queue_profile(client, tenant_a_id, donor_org_unit_id)
        _seed_actuals(client, tenant_a_id, donor_org_unit_id, weeks=3)

        job = _cold_start_job(client, tenant_a_id, target_org_unit_id, start=start, end=end)
        assert job["status"] == "completed"

        poll = client.get(
            f"/v1/forecasting/jobs/{job['jobId']}", headers=auth_headers(tenant_a_id)
        )
        run = poll.json()

        # Post an "actual" at the exact first forecasted interval of the
        # cold-start run's date range - the forecast horizon starts at
        # midnight UTC of `start`.
        forecasted_interval = datetime.fromisoformat(f"{start}T00:00:00+00:00")
        ingest_response = client.post(
            "/v1/forecasting/actuals",
            json={
                "orgUnitId": str(target_org_unit_id),
                "points": [
                    {
                        "intervalStart": forecasted_interval.isoformat(),
                        "actualVolume": "12.0",
                    }
                ],
            },
            headers=auth_headers(tenant_a_id),
        )
        assert ingest_response.status_code == 200, ingest_response.text
        ingest_body = ingest_response.json()
        assert ingest_body["accuracyLogged"] == 1

        trend_response = client.get(
            f"/v1/forecasting/accuracy/{target_org_unit_id}", headers=auth_headers(tenant_a_id)
        )
    assert trend_response.status_code == 200
    points = trend_response.json()["points"]
    assert len(points) == 1
    assert points[0]["forecastRunId"] == run["id"]
    assert float(points[0]["actualVolume"]) == 12.0
    assert points[0]["mape"] is not None
    assert points[0]["bias"] is not None


async def test_re_ingesting_the_same_interval_does_not_double_log_accuracy(tenant_a_id: uuid.UUID) -> None:
    target_org_unit_id = uuid.uuid4()
    donor_org_unit_id = uuid.uuid4()
    start, end = _date_range(start_offset_days=1, span_days=1)

    with TestClient(app) as client:
        _seed_queue_profile(client, tenant_a_id, target_org_unit_id)
        _seed_queue_profile(client, tenant_a_id, donor_org_unit_id)
        _seed_actuals(client, tenant_a_id, donor_org_unit_id, weeks=3)
        _cold_start_job(client, tenant_a_id, target_org_unit_id, start=start, end=end)

        forecasted_interval = datetime.fromisoformat(f"{start}T00:00:00+00:00")
        payload = {
            "orgUnitId": str(target_org_unit_id),
            "points": [{"intervalStart": forecasted_interval.isoformat(), "actualVolume": "12.0"}],
        }
        first = client.post(
            "/v1/forecasting/actuals", json=payload, headers=auth_headers(tenant_a_id)
        )
        second = client.post(
            "/v1/forecasting/actuals", json=payload, headers=auth_headers(tenant_a_id)
        )

    assert first.json()["accuracyLogged"] == 1
    assert second.json()["accuracyLogged"] == 0


async def test_ingesting_an_actual_with_no_matching_forecast_logs_nothing(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.post(
            "/v1/forecasting/actuals",
            json={
                "orgUnitId": str(org_unit_id),
                "points": [{"intervalStart": datetime.now(UTC).isoformat(), "actualVolume": "5.0"}],
            },
            headers=auth_headers(tenant_a_id),
        )
    assert response.status_code == 200
    assert response.json()["accuracyLogged"] == 0


async def test_a_tenant_cannot_see_another_tenants_accuracy_trend(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/accuracy/{org_unit_id}", headers=auth_headers(tenant_b_id)
        )
    assert response.status_code == 200
    assert response.json()["points"] == []
