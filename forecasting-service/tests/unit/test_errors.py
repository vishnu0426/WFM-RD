from __future__ import annotations

from app.core.errors import (
    STATUS_BY_CODE,
    ForecastRunNotFoundError,
    InsufficientDataError,
    InvalidTenantIdError,
    TenantContextMissingError,
)


def test_envelope_shape_matches_platform_convention() -> None:
    err = ForecastRunNotFoundError("11111111-1111-1111-1111-111111111111")
    envelope = err.to_envelope()
    assert set(envelope.keys()) == {"error"}
    assert set(envelope["error"].keys()) == {"code", "message", "details"}
    assert envelope["error"]["code"] == "NOT_FOUND"
    assert envelope["error"]["details"] == {"jobId": "11111111-1111-1111-1111-111111111111"}


def test_status_by_code_covers_every_declared_error() -> None:
    assert STATUS_BY_CODE["TENANT_CONTEXT_MISSING"] == 400
    assert STATUS_BY_CODE["INVALID_TENANT_ID"] == 400
    assert STATUS_BY_CODE["NOT_FOUND"] == 404
    assert STATUS_BY_CODE["INSUFFICIENT_DATA"] == 422


def test_tenant_context_missing_error_has_no_leaked_details() -> None:
    err = TenantContextMissingError()
    assert err.to_envelope()["error"]["details"] == {}


def test_invalid_tenant_id_error_echoes_offending_value() -> None:
    err = InvalidTenantIdError("not-a-uuid")
    assert err.to_envelope()["error"]["details"] == {"value": "not-a-uuid"}


def test_insufficient_data_error_reserved_for_phase_2() -> None:
    # Not raised anywhere in Phase 1's code paths (docs/adr/0019) - this test
    # only proves the code/status exist for Phase 2 to use.
    err = InsufficientDataError("queue has insufficient history")
    assert err.http_status == 422
    assert err.code == "INSUFFICIENT_DATA"
