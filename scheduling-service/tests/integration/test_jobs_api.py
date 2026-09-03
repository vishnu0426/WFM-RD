"""End-to-end §4.1 contract test: `POST /v1/scheduling/jobs` then
`GET /v1/scheduling/jobs/{jobId}` against the real FastAPI app, a real
Postgres (Phase 1 migration applied), and a real NATS. Python analogue of
`test/integration/org-api-http.spec.ts` and Module 03's own `test_jobs_api.py`.

Phase 1 has no solver, so every submission lands at `status: queued` and
stays there - "does it ever transition" is out of scope until Phase 2+ wires
CP-SAT in. What this phase actually proves: the row is created, the
idempotency-key contract holds, and tenant isolation holds over HTTP.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return {**auth_headers(tenant_id), "Idempotency-Key": str(uuid.uuid4())}


def _job_body(org_unit_id: uuid.UUID, forecast_run_id: uuid.UUID) -> dict[str, object]:
    start = date.today() + timedelta(days=7)
    end = start + timedelta(days=13)
    return {
        "orgUnitId": str(org_unit_id),
        "forecastRunId": str(forecast_run_id),
        "dateRange": {"start": start.isoformat(), "end": end.isoformat()},
        "constraintConfig": {"softWeights": {"preferenceWeight": 5}},
    }


async def test_submit_job_creates_a_queued_job(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    forecast_run_id = uuid.uuid4()
    with TestClient(app) as client:
        submit_response = client.post(
            "/v1/scheduling/jobs",
            json=_job_body(org_unit_id, forecast_run_id),
            headers=_headers(tenant_a_id),
        )
        assert submit_response.status_code == 201, submit_response.text
        assert submit_response.json()["status"] == "queued"

        job_id = submit_response.json()["jobId"]
        poll_response = client.get(
            f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_a_id)
        )

    assert poll_response.status_code == 200
    job = poll_response.json()
    assert job["status"] == "queued"
    assert job["orgUnitId"] == str(org_unit_id)
    assert job["forecastRunId"] == str(forecast_run_id)
    # §2.2 rule 3's constraint_config now has a validated shape (Phase 3) -
    # what's persisted/echoed back is the full parsed+defaulted object, not
    # a verbatim copy of whatever arbitrary keys the caller sent.
    assert job["constraintConfig"] == {
        "fairness": None,
        "softWeights": {
            "preferenceWeight": 5,
            "overtimeCostWeight": 1,
            "skillDecayWeight": 1,
            "crossSkillBalanceWeight": 1,
        },
    }
    assert job["decompositionPlan"] is None
    assert job["relaxationsApplied"] is None


async def test_submitting_without_idempotency_key_is_rejected(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/scheduling/jobs",
            json=_job_body(uuid.uuid4(), uuid.uuid4()),
            headers=auth_headers(tenant_a_id),
        )
    assert response.status_code == 422


async def test_same_idempotency_key_returns_the_same_job(tenant_a_id: uuid.UUID) -> None:
    headers = _headers(tenant_a_id)
    body = _job_body(uuid.uuid4(), uuid.uuid4())
    with TestClient(app) as client:
        first = client.post("/v1/scheduling/jobs", json=body, headers=headers)
        second = client.post("/v1/scheduling/jobs", json=body, headers=headers)

    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["jobId"] == second.json()["jobId"]


async def test_a_tenant_cannot_poll_another_tenants_job(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    with TestClient(app) as client:
        submit_response = client.post(
            "/v1/scheduling/jobs",
            json=_job_body(uuid.uuid4(), uuid.uuid4()),
            headers=_headers(tenant_a_id),
        )
        job_id = submit_response.json()["jobId"]

        cross_tenant_response = client.get(
            f"/v1/scheduling/jobs/{job_id}", headers=auth_headers(tenant_b_id)
        )

    assert cross_tenant_response.status_code == 404
    assert cross_tenant_response.json()["error"]["code"] == "NOT_FOUND"


async def test_missing_bearer_token_fails_closed() -> None:
    """GAP-08 fix (enterprise readiness audit, 2026-08-18): a request with no
    `Authorization` header at all is now rejected by `TenantContextMiddleware`
    itself, before any route runs - superseding the old raw-header placeholder's
    `TENANT_CONTEXT_MISSING` (400), which only ever fired if a route ran with no
    tenant context bound."""
    with TestClient(app) as client:
        response = client.get(f"/v1/scheduling/jobs/{uuid.uuid4()}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_AUTHENTICATION"


async def test_invalid_date_range_is_rejected(tenant_a_id: uuid.UUID) -> None:
    body = _job_body(uuid.uuid4(), uuid.uuid4())
    body["dateRange"] = {"start": "2026-02-10", "end": "2026-02-01"}
    with TestClient(app) as client:
        response = client.post("/v1/scheduling/jobs", json=body, headers=_headers(tenant_a_id))

    # Pydantic's own 422, raised by DateRange's model_validator before the
    # request ever reaches job_service/the DB - see app/api/v1/schemas.py.
    assert response.status_code == 422
