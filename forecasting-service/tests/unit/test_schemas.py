from __future__ import annotations

import uuid

from app.api.v1.schemas import ForecastJobRequest


def test_forecast_job_request_accepts_camel_case_wire_format() -> None:
    org_unit_id = uuid.uuid4()
    payload = {
        "orgUnitId": str(org_unit_id),
        "dateRange": {"start": "2026-01-01", "end": "2026-01-31"},
        "intervalMinutes": 30,
    }
    request = ForecastJobRequest.model_validate(payload)
    assert request.org_unit_id == org_unit_id
    assert request.interval_minutes == 30
    assert str(request.date_range.start) == "2026-01-01"


def test_forecast_job_request_serializes_back_to_camel_case() -> None:
    payload = {
        "orgUnitId": str(uuid.uuid4()),
        "dateRange": {"start": "2026-01-01", "end": "2026-01-31"},
        "intervalMinutes": 15,
    }
    request = ForecastJobRequest.model_validate(payload)
    dumped = request.model_dump(by_alias=True, mode="json")
    assert dumped["intervalMinutes"] == 15
    assert dumped["dateRange"]["start"] == "2026-01-01"
