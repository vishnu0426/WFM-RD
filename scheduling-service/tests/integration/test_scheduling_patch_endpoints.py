"""`PATCH /{id}` for shift-templates, work-patterns, and staffing-profiles —
these 3 resources previously supported only POST/GET/DELETE (delete +
recreate to "edit"). Proves: a PATCH updates only the field(s) provided,
leaves the rest untouched; a PATCH on a nonexistent id 404s; a PATCH against
another tenant's row also 404s (tenant isolation), mirroring how DELETE
already tenant-isolates on this same trio of resources.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.jwt_test_helpers import auth_headers

pytestmark = pytest.mark.asyncio


async def test_patch_shift_template_updates_only_provided_fields(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        create = client.post(
            "/v1/scheduling/shift-templates",
            json={
                "name": "Morning",
                "startTime": "07:00",
                "endTime": "15:00",
                "breakMinutes": 30,
                "defaultHeadcount": 12,
            },
            headers=auth_headers(tenant_a_id),
        )
        assert create.status_code == 201, create.text
        template_id = create.json()["id"]

        patch = client.patch(
            f"/v1/scheduling/shift-templates/{template_id}",
            json={"defaultHeadcount": 15},
            headers=auth_headers(tenant_a_id),
        )
        assert patch.status_code == 200, patch.text
        body = patch.json()
        assert body["defaultHeadcount"] == 15
        assert body["name"] == "Morning"
        assert body["startTime"] == "07:00"

        missing = client.patch(
            f"/v1/scheduling/shift-templates/{uuid.uuid4()}",
            json={"defaultHeadcount": 1},
            headers=auth_headers(tenant_a_id),
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "SHIFT_TEMPLATE_NOT_FOUND"


async def test_patch_shift_template_is_tenant_isolated(
    tenant_a_id: uuid.UUID, tenant_b_id: uuid.UUID
) -> None:
    with TestClient(app) as client:
        create = client.post(
            "/v1/scheduling/shift-templates",
            json={"name": "Night", "startTime": "23:00", "endTime": "07:00", "defaultHeadcount": 4},
            headers=auth_headers(tenant_a_id),
        )
        template_id = create.json()["id"]

        cross_tenant = client.patch(
            f"/v1/scheduling/shift-templates/{template_id}",
            json={"defaultHeadcount": 99},
            headers=auth_headers(tenant_b_id),
        )
        assert cross_tenant.status_code == 404


async def test_patch_work_pattern_updates_only_provided_fields(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        shift = client.post(
            "/v1/scheduling/shift-templates",
            json={"name": "Day", "startTime": "09:00", "endTime": "17:00", "defaultHeadcount": 6},
            headers=auth_headers(tenant_a_id),
        )
        shift_id = shift.json()["id"]

        create = client.post(
            "/v1/scheduling/work-patterns",
            json={"name": "4-on-3-off", "days": [shift_id, shift_id, shift_id, shift_id, None, None, None]},
            headers=auth_headers(tenant_a_id),
        )
        assert create.status_code == 201, create.text
        pattern_id = create.json()["id"]

        patch = client.patch(
            f"/v1/scheduling/work-patterns/{pattern_id}",
            json={"name": "4-on-3-off (renamed)"},
            headers=auth_headers(tenant_a_id),
        )
        assert patch.status_code == 200, patch.text
        body = patch.json()
        assert body["name"] == "4-on-3-off (renamed)"
        assert body["days"] == [shift_id, shift_id, shift_id, shift_id, None, None, None]

        missing = client.patch(
            f"/v1/scheduling/work-patterns/{uuid.uuid4()}",
            json={"name": "x"},
            headers=auth_headers(tenant_a_id),
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "WORK_PATTERN_NOT_FOUND"


async def test_patch_staffing_profile_updates_only_provided_fields(tenant_a_id: uuid.UUID) -> None:
    with TestClient(app) as client:
        shift = client.post(
            "/v1/scheduling/shift-templates",
            json={"name": "Afternoon", "startTime": "15:00", "endTime": "23:00", "defaultHeadcount": 10},
            headers=auth_headers(tenant_a_id),
        )
        shift_id = shift.json()["id"]

        create = client.post(
            "/v1/scheduling/staffing-profiles",
            json={
                "name": "Standard weekday",
                "entries": [{"shiftTemplateId": shift_id, "requiredHeadcount": 10}],
            },
            headers=auth_headers(tenant_a_id),
        )
        assert create.status_code == 201, create.text
        profile_id = create.json()["id"]

        patch = client.patch(
            f"/v1/scheduling/staffing-profiles/{profile_id}",
            json={"entries": [{"shiftTemplateId": shift_id, "requiredHeadcount": 20}]},
            headers=auth_headers(tenant_a_id),
        )
        assert patch.status_code == 200, patch.text
        body = patch.json()
        assert body["name"] == "Standard weekday"
        assert body["entries"] == [{"shiftTemplateId": shift_id, "requiredHeadcount": 20}]

        missing = client.patch(
            f"/v1/scheduling/staffing-profiles/{uuid.uuid4()}",
            json={"name": "x"},
            headers=auth_headers(tenant_a_id),
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "STAFFING_PROFILE_NOT_FOUND"
