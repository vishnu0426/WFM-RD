"""Module 08/ADR-0102's legal-floor client. Same monkeypatched-stub
convention as `test_leave_client.py`."""

from __future__ import annotations

import uuid
from datetime import date
from typing import cast

import grpc
import pytest

from app.grpc_clients import compliance_client
from app.grpc_clients.generated import compliance_pb2

_TENANT_ID = uuid.uuid4()
_STUB_TARGET = "app.grpc_clients.compliance_client.compliance_pb2_grpc.ComplianceRuleServiceStub"
_UNUSED_CHANNEL = cast(grpc.aio.Channel, object())


class _FakeStub:
    def __init__(self, response: compliance_pb2.ComplianceRuleResponse) -> None:
        self._response = response
        self.last_request: compliance_pb2.GetActiveRuleRequest | None = None

    async def GetActiveRule(  # noqa: N802 - matches the generated stub's method name
        self, request: compliance_pb2.GetActiveRuleRequest
    ) -> compliance_pb2.ComplianceRuleResponse:
        self.last_request = request
        return self._response


async def test_parses_the_definition_json_of_a_found_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_stub = _FakeStub(
        compliance_pb2.ComplianceRuleResponse(
            found=True,
            id="rule-1",
            definition_json='{"minRestHoursBetweenShifts": 10}',
        )
    )
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await compliance_client.get_active_rule_definition(
        _UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        jurisdiction="US-CA",
        rule_type="rest_period_minimum",
        as_of=date(2026, 6, 1),
    )

    assert result == {"minRestHoursBetweenShifts": 10}
    assert fake_stub.last_request is not None
    assert fake_stub.last_request.jurisdiction == "US-CA"
    assert fake_stub.last_request.rule_type == "rest_period_minimum"


async def test_not_found_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_stub = _FakeStub(compliance_pb2.ComplianceRuleResponse(found=False))
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await compliance_client.get_active_rule_definition(
        _UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        jurisdiction="US-CA",
        rule_type="rest_period_minimum",
        as_of=date(2026, 6, 1),
    )

    assert result is None


async def test_unparseable_definition_json_falls_back_to_none_not_an_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_stub = _FakeStub(
        compliance_pb2.ComplianceRuleResponse(found=True, id="rule-1", definition_json="not json")
    )
    monkeypatch.setattr(_STUB_TARGET, lambda channel: fake_stub)

    result = await compliance_client.get_active_rule_definition(
        _UNUSED_CHANNEL,
        tenant_id=_TENANT_ID,
        jurisdiction="US-CA",
        rule_type="rest_period_minimum",
        as_of=date(2026, 6, 1),
    )

    assert result is None
