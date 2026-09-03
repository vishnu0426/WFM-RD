from __future__ import annotations

from app.core.errors import (
    STATUS_BY_CODE,
    InvalidTenantIdError,
    NotFoundError,
    ScheduleJobNotFoundError,
    TenantContextMissingError,
)


def test_envelope_shape_matches_platform_convention() -> None:
    err = ScheduleJobNotFoundError("11111111-1111-1111-1111-111111111111")
    envelope = err.to_envelope()
    assert set(envelope.keys()) == {"error"}
    assert set(envelope["error"].keys()) == {"code", "message", "details"}
    assert envelope["error"]["code"] == "NOT_FOUND"
    assert envelope["error"]["details"] == {"jobId": "11111111-1111-1111-1111-111111111111"}


def test_schedule_job_not_found_is_a_not_found_error() -> None:
    assert issubclass(ScheduleJobNotFoundError, NotFoundError)


def test_status_by_code_covers_every_declared_error() -> None:
    assert STATUS_BY_CODE["TENANT_CONTEXT_MISSING"] == 400
    assert STATUS_BY_CODE["INVALID_TENANT_ID"] == 400
    assert STATUS_BY_CODE["NOT_FOUND"] == 404


def test_tenant_context_missing_error_has_no_leaked_details() -> None:
    err = TenantContextMissingError()
    assert err.to_envelope()["error"]["details"] == {}


def test_invalid_tenant_id_error_echoes_offending_value() -> None:
    err = InvalidTenantIdError("not-a-uuid")
    assert err.to_envelope()["error"]["details"] == {"value": "not-a-uuid"}
