"""ADR-0025 Decision 5's `SpecialEvent` tagging endpoints: create/list, RLS
isolation, and tenant-wide (`org_unit_id=None`) events showing up alongside
org-unit-specific ones for any org unit's listing."""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio


def _headers(tenant_id: uuid.UUID) -> dict[str, str]:
    return auth_headers(tenant_id)


def _event_body(
    *, org_unit_id: uuid.UUID | None, event_type: str = "holiday", days_ahead: int = 30
) -> dict[str, object]:
    start = date.today() + timedelta(days=days_ahead)
    end = start + timedelta(days=1)
    return {
        "orgUnitId": str(org_unit_id) if org_unit_id is not None else None,
        "eventType": event_type,
        "dateRange": {"start": start.isoformat(), "end": end.isoformat()},
        "expectedVolumeMultiplier": "1.500",
    }


async def test_create_then_list_returns_the_created_event(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/forecasting/special-events",
            json=_event_body(org_unit_id=org_unit_id),
            headers=_headers(tenant_a_id),
        )
        assert create_response.status_code == 200, create_response.text
        created = create_response.json()
        assert created["eventType"] == "holiday"
        assert created["orgUnitId"] == str(org_unit_id)

        list_response = client.get(
            "/v1/forecasting/special-events",
            params={"orgUnitId": str(org_unit_id)},
            headers=_headers(tenant_a_id),
        )
    assert list_response.status_code == 200
    ids = [event["id"] for event in list_response.json()]
    assert created["id"] in ids


async def test_a_tenant_wide_event_appears_when_listing_any_org_unit(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        create_response = client.post(
            "/v1/forecasting/special-events",
            json=_event_body(org_unit_id=None, event_type="marketing_campaign"),
            headers=_headers(tenant_a_id),
        )
        assert create_response.status_code == 200, create_response.text
        tenant_wide_id = create_response.json()["id"]
        assert create_response.json()["orgUnitId"] is None

        list_response = client.get(
            "/v1/forecasting/special-events",
            params={"orgUnitId": str(org_unit_id)},
            headers=_headers(tenant_a_id),
        )
    ids = [event["id"] for event in list_response.json()]
    assert tenant_wide_id in ids


async def test_a_tenant_cannot_see_another_tenants_events(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        client.post(
            "/v1/forecasting/special-events",
            json=_event_body(org_unit_id=org_unit_id),
            headers=_headers(tenant_a_id),
        )
        response = client.get(
            "/v1/forecasting/special-events",
            params={"orgUnitId": str(org_unit_id)},
            headers=_headers(tenant_b_id),
        )
    assert response.status_code == 200
    assert response.json() == []


async def test_rejects_an_unsupported_event_type(tenant_a_id: uuid.UUID) -> None:
    org_unit_id = uuid.uuid4()
    with TestClient(app) as client:
        response = client.post(
            "/v1/forecasting/special-events",
            json=_event_body(org_unit_id=org_unit_id, event_type="not_a_real_type"),
            headers=_headers(tenant_a_id),
        )
    assert response.status_code == 422
