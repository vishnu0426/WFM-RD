"""Module 08/ADR-0102's jurisdiction-resolution client. Same monkeypatched-
stub convention as `test_leave_client.py` - see that file's own doc
comment for why."""

from __future__ import annotations

import uuid
from datetime import date
from typing import cast

import grpc
import pytest

from app.grpc_clients import calendar_client
from app.grpc_clients.generated import calendar_pb2

_TENANT_ID = uuid.uuid4()
_ORG_UNIT_ID = uuid.uuid4()
_STUB_TARGET = "app.grpc_clients.calendar_client.calendar_pb2_grpc.CalendarServiceStub"
_UNUSED_CHANNEL = cast(grpc.aio.Channel, object())


class _FakeStub:
    def __init__(self, response: calendar_pb2.WorkingTimeRules) -> None:
        self._response = response
        self.last_request: calendar_pb2.GetWorkingTimeRulesRequest | None = None

    async def GetWorkingTimeRules(  # noqa: N802 - matches the generated stub's method name
        self, request: calendar_pb2.GetWorkingTimeRulesRequest
    ) -> calendar_pb2.WorkingTimeRules:
        self.last_request = request
        return self._response


async def test_returns_the_country_code_from_a_real_response(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_stub = _FakeStub(calendar_pb2.WorkingTimeRules(country_code="GB", timezone="Europe/London"))
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await calendar_client.get_org_unit_country_code(
        _UNUSED_CHANNEL, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=date(2026, 6, 1)
    )

    assert result == "GB"
    assert fake_stub.last_request is not None
    assert fake_stub.last_request.tenant_id == str(_TENANT_ID)
    assert fake_stub.last_request.org_unit_id == str(_ORG_UNIT_ID)


async def test_empty_country_code_is_none_not_an_empty_string(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_stub = _FakeStub(calendar_pb2.WorkingTimeRules(country_code=""))
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await calendar_client.get_org_unit_country_code(
        _UNUSED_CHANNEL, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=date(2026, 6, 1)
    )

    assert result is None
