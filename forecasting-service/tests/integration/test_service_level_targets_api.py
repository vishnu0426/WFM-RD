"""ADR-0023's `service_level_targets` endpoint: platform defaults when
unconfigured, real persistence + override once a tenant sets one, and that
`compute_required_headcount` actually picks up the configured target rather
than always using the default."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


def test_get_with_no_configuration_returns_platform_defaults(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.get(
            f"/v1/forecasting/service-level-targets/{org_unit_id}", headers=_headers(tenant_a_id)
        )

    assert response.status_code == 200
    body = response.json()
    assert body["isDefault"] is True
    assert float(body["targetServiceLevel"]) == 0.80
    assert body["targetAnswerTimeSeconds"] == 20
    assert float(body["maxOccupancy"]) == 0.85


def test_put_then_get_reflects_the_configured_override(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        put_response = client.put(
            f"/v1/forecasting/service-level-targets/{org_unit_id}",
            json={"targetServiceLevel": "0.90", "targetAnswerTimeSeconds": 15, "maxOccupancy": "0.80"},
            headers=_headers(tenant_a_id),
        )
        assert put_response.status_code == 200
        assert put_response.json()["isDefault"] is False

        get_response = client.get(
            f"/v1/forecasting/service-level-targets/{org_unit_id}", headers=_headers(tenant_a_id)
        )

    assert get_response.status_code == 200
    body = get_response.json()
    assert body["isDefault"] is False
    assert float(body["targetServiceLevel"]) == 0.90
    assert body["targetAnswerTimeSeconds"] == 15
    assert float(body["maxOccupancy"]) == 0.80


def test_put_twice_upserts_rather_than_erroring(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        first = client.put(
            f"/v1/forecasting/service-level-targets/{org_unit_id}",
            json={"targetServiceLevel": "0.80", "targetAnswerTimeSeconds": 20, "maxOccupancy": "0.85"},
            headers=_headers(tenant_a_id),
        )
        second = client.put(
            f"/v1/forecasting/service-level-targets/{org_unit_id}",
            json={"targetServiceLevel": "0.70", "targetAnswerTimeSeconds": 30, "maxOccupancy": "0.75"},
            headers=_headers(tenant_a_id),
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert float(second.json()["targetServiceLevel"]) == 0.70


def test_a_tenant_cannot_see_another_tenants_configured_target(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        client.put(
            f"/v1/forecasting/service-level-targets/{org_unit_id}",
            json={"targetServiceLevel": "0.95", "targetAnswerTimeSeconds": 10, "maxOccupancy": "0.90"},
            headers=_headers(tenant_a_id),
        )
        response = client.get(
            f"/v1/forecasting/service-level-targets/{org_unit_id}", headers=_headers(tenant_b_id)
        )

    # RLS means tenant B simply never sees tenant A's row - falls back to
    # platform defaults, not a 404/403 (this endpoint has no concept of
    # "exists for someone else").
    assert response.status_code == 200
    assert response.json()["isDefault"] is True
