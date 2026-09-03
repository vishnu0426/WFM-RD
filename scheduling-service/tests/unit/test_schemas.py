from __future__ import annotations

import uuid
from datetime import date

import pytest
from pydantic import ValidationError

from app.api.v1.schemas import ConstraintConfigInput, DateRange, ScheduleJobRequest


def test_date_range_accepts_start_equal_to_end() -> None:
    DateRange(start=date(2026, 1, 1), end=date(2026, 1, 1))


def test_date_range_rejects_end_before_start() -> None:
    with pytest.raises(ValidationError):
        DateRange(start=date(2026, 1, 10), end=date(2026, 1, 1))


def test_schedule_job_request_round_trips_camel_case_wire_format() -> None:
    payload = {
        "orgUnitId": str(uuid.uuid4()),
        "forecastRunId": str(uuid.uuid4()),
        "dateRange": {"start": "2026-01-01", "end": "2026-01-31"},
    }
    request = ScheduleJobRequest.model_validate(payload)
    # Omitting constraintConfig entirely is a valid, explicit "use platform
    # defaults" request (§2.2 rule 3) - fairness is opt-in (None), soft
    # weights default to a modest positive value each (Phase 3 design doc).
    assert request.constraint_config == ConstraintConfigInput()
    assert request.constraint_config.fairness is None
    assert str(request.model_dump(by_alias=True)["orgUnitId"]) == payload["orgUnitId"]
