"""Module 06 Phase 5/ADR-0078's `LeaveService.GetUnavailability` client.
Mocks the generated `LeaveServiceStub` directly (there is no lighter way to
test this in isolation without a live gRPC server) - this repo's own
established convention for this feature area is integration-only testing
against a real running server (`tests/integration/test_grpc_data_pulls_api.py`);
this unit test covers the pure request/response conversion logic that
doesn't need one, and is a genuine addition to, not a replacement for,
real end-to-end verification.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import cast

import grpc
import pytest

from app.grpc_clients import leave_client
from app.grpc_clients.generated import leave_pb2
from app.solver.types import LeaveRecord

_TENANT_ID = uuid.uuid4()
_EMPLOYEE_ID = uuid.uuid4()
_STUB_TARGET = "app.grpc_clients.leave_client.leave_pb2_grpc.LeaveServiceStub"
# The stub constructor is monkeypatched in every test below, so the real
# channel value is never used - a `cast`, not a real channel, is the
# honest way to satisfy the signature.
_UNUSED_CHANNEL = cast(grpc.aio.Channel, object())


class _FakeStub:
    def __init__(self, response: leave_pb2.GetUnavailabilityResponse) -> None:
        self._response = response
        self.last_request: leave_pb2.GetUnavailabilityRequest | None = None

    async def GetUnavailability(  # noqa: N802 - matches the generated stub's method name
        self, request: leave_pb2.GetUnavailabilityRequest
    ) -> leave_pb2.GetUnavailabilityResponse:
        self.last_request = request
        return self._response


async def test_converts_response_records_to_leave_record_dataclasses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = leave_pb2.GetUnavailabilityResponse(
        records=[
            leave_pb2.UnavailabilityRecord(
                employee_id=str(_EMPLOYEE_ID),
                start_date="2026-06-01",
                end_date="2026-06-03",
                leave_type_id="type-1",
            )
        ]
    )
    fake_stub = _FakeStub(response)
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await leave_client.get_unavailability(
        channel=_UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        employee_ids=(_EMPLOYEE_ID,),
        date_range_start=date(2026, 6, 1),
        date_range_end=date(2026, 6, 30),
    )

    assert result == (LeaveRecord(employee_id=_EMPLOYEE_ID, start=date(2026, 6, 1), end=date(2026, 6, 3)),)
    assert fake_stub.last_request is not None
    assert fake_stub.last_request.tenant_id == str(_TENANT_ID)
    assert list(fake_stub.last_request.employee_ids) == [str(_EMPLOYEE_ID)]


async def test_empty_records_response_is_a_normal_result_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_stub = _FakeStub(leave_pb2.GetUnavailabilityResponse(records=[]))
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await leave_client.get_unavailability(
        channel=_UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        employee_ids=(_EMPLOYEE_ID,),
        date_range_start=date(2026, 6, 1),
        date_range_end=date(2026, 6, 30),
    )

    assert result == ()


async def test_no_employee_ids_short_circuits_without_calling_the_stub(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def _stub_ctor(channel: object) -> _FakeStub:
        nonlocal calls
        calls += 1
        return _FakeStub(leave_pb2.GetUnavailabilityResponse())

    monkeypatch.setattr(_STUB_TARGET, _stub_ctor)

    result = await leave_client.get_unavailability(
        channel=_UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        employee_ids=(),
        date_range_start=date(2026, 6, 1),
        date_range_end=date(2026, 6, 30),
    )

    assert result == ()
    assert calls == 0
