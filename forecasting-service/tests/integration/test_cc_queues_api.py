"""`cc_queues` CRUD + the `/resolve/{external_queue_id}` lookup that's the
intended join point for `intraday-service`/`integration-hub-service` to map
a raw ACD queue id back to a tenant/org unit. See `CcQueue`'s own doc
comment (`app/db/models.py`) for the full rationale."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


def test_create_then_get_round_trips(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/forecasting/cc-queues",
            json={
                "orgUnitId": str(org_unit_id),
                "externalQueueId": "q_billing_us",
                "name": "Billing (US)",
                "acdProvider": "five9",
                "channel": "voice",
            },
            headers=_headers(tenant_a_id),
        )
        assert create_response.status_code == 201
        queue_id = create_response.json()["id"]

        get_response = client.get(f"/v1/forecasting/cc-queues/{queue_id}", headers=_headers(tenant_a_id))

    assert get_response.status_code == 200
    body = get_response.json()
    assert body["externalQueueId"] == "q_billing_us"
    assert body["orgUnitId"] == str(org_unit_id)
    assert body["acdProvider"] == "five9"
    assert body["status"] == "active"


def test_resolve_by_external_queue_id(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        client.post(
            "/v1/forecasting/cc-queues",
            json={
                "orgUnitId": str(org_unit_id),
                "externalQueueId": "q_tech_tier2",
                "name": "Tech Tier 2",
            },
            headers=_headers(tenant_a_id),
        )

        response = client.get("/v1/forecasting/cc-queues/resolve/q_tech_tier2", headers=_headers(tenant_a_id))

    assert response.status_code == 200
    assert response.json()["orgUnitId"] == str(org_unit_id)


def test_resolve_unknown_external_queue_id_is_404(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        response = client.get(
            "/v1/forecasting/cc-queues/resolve/does-not-exist", headers=_headers(tenant_a_id)
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_list_filters_by_org_unit(tenant_a_id: uuid.UUID) -> None:
    org_unit_a = uuid.uuid4()
    org_unit_b = uuid.uuid4()
    with TestClient(app) as client:
        client.post(
            "/v1/forecasting/cc-queues",
            json={"orgUnitId": str(org_unit_a), "externalQueueId": "q_a", "name": "Queue A"},
            headers=_headers(tenant_a_id),
        )
        client.post(
            "/v1/forecasting/cc-queues",
            json={"orgUnitId": str(org_unit_b), "externalQueueId": "q_b", "name": "Queue B"},
            headers=_headers(tenant_a_id),
        )

        response = client.get(
            "/v1/forecasting/cc-queues",
            params={"org_unit_id": str(org_unit_a)},
            headers=_headers(tenant_a_id),
        )

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["externalQueueId"] == "q_a"


def test_a_tenant_cannot_see_another_tenants_queue(tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/forecasting/cc-queues",
            json={"orgUnitId": str(org_unit_id), "externalQueueId": "q_private", "name": "Private"},
            headers=_headers(tenant_a_id),
        )
        queue_id = create_response.json()["id"]

        get_response = client.get(f"/v1/forecasting/cc-queues/{queue_id}", headers=_headers(tenant_b_id))
        resolve_response = client.get(
            "/v1/forecasting/cc-queues/resolve/q_private", headers=_headers(tenant_b_id)
        )

    # RLS means tenant B's session never sees tenant A's row at all - a
    # genuine 404, not a 403 (same posture `test_service_level_targets_api.py`
    # documents for this platform's RLS-backed tenant isolation).
    assert get_response.status_code == 404
    assert resolve_response.status_code == 404


def test_update_then_delete(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/forecasting/cc-queues",
            json={"orgUnitId": str(org_unit_id), "externalQueueId": "q_x", "name": "Queue X"},
            headers=_headers(tenant_a_id),
        )
        queue_id = create_response.json()["id"]

        update_response = client.put(
            f"/v1/forecasting/cc-queues/{queue_id}",
            json={
                "orgUnitId": str(org_unit_id),
                "externalQueueId": "q_x",
                "name": "Queue X Renamed",
                "status": "inactive",
            },
            headers=_headers(tenant_a_id),
        )
        assert update_response.status_code == 200
        assert update_response.json()["name"] == "Queue X Renamed"
        assert update_response.json()["status"] == "inactive"

        delete_response = client.delete(
            f"/v1/forecasting/cc-queues/{queue_id}", headers=_headers(tenant_a_id)
        )
        assert delete_response.status_code == 204

        get_response = client.get(f"/v1/forecasting/cc-queues/{queue_id}", headers=_headers(tenant_a_id))

    assert get_response.status_code == 404
