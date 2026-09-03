"""Module 06 Phase 5/ADR-0078's `_resolve_leave_records` - the same
optional-field-triggers-pull branching ADR-0059 established for
`_resolve_roster`/`_resolve_policy`, tested in isolation the same way
`tests/unit/test_grpc_retry.py` isolates the retry wrapper: monkeypatch the
one external call (`leave_client.get_unavailability`), assert the branch
taken, not the network behavior underneath it (that's
`tests/integration/test_grpc_data_pulls_api.py`'s job, and this phase's own
real-server manual verification, see the Phase 5 design doc).
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.api.v1.schemas import DateRange, LeaveRecordInput, ScheduleJobRequest
from app.services.solve_input_resolver import _resolve_leave_records
from app.solver.types import Employee, LeaveRecord

_TENANT_ID = uuid.uuid4()
_EMPLOYEE_ID = uuid.uuid4()
_RESOLVER_TARGET = "app.services.solve_input_resolver.leave_client.get_unavailability"


def _request(*, leave_records: list[LeaveRecordInput] | None) -> ScheduleJobRequest:
    return ScheduleJobRequest(
        org_unit_id=uuid.uuid4(),
        date_range=DateRange(start=date(2026, 6, 1), end=date(2026, 6, 30)),
        forecast_run_id=uuid.uuid4(),
        leave_records=leave_records,
    )


async def test_explicit_leave_records_wins_outright_without_calling_grpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def _should_not_be_called(*args: object, **kwargs: object) -> tuple[LeaveRecord, ...]:
        nonlocal calls
        calls += 1
        return ()

    monkeypatch.setattr(_RESOLVER_TARGET, _should_not_be_called)

    explicit_record = LeaveRecordInput(
        employee_id=_EMPLOYEE_ID, date_range=DateRange(start=date(2026, 6, 5), end=date(2026, 6, 6))
    )
    body = _request(leave_records=[explicit_record])
    employees = (Employee(id=_EMPLOYEE_ID, contract_hours_per_week=40.0),)

    result = await _resolve_leave_records(body, tenant_id=_TENANT_ID, employees=employees)

    assert result == (LeaveRecord(employee_id=_EMPLOYEE_ID, start=date(2026, 6, 5), end=date(2026, 6, 6)),)
    assert calls == 0


async def test_explicit_empty_list_also_wins_outright_distinct_from_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`leave_records: []` means "explicitly zero" - never a pull, same as `roster: []` (ADR-0059)."""
    calls = 0

    async def _should_not_be_called(*args: object, **kwargs: object) -> tuple[LeaveRecord, ...]:
        nonlocal calls
        calls += 1
        return ()

    monkeypatch.setattr(_RESOLVER_TARGET, _should_not_be_called)

    body = _request(leave_records=[])
    employees = (Employee(id=_EMPLOYEE_ID, contract_hours_per_week=40.0),)

    result = await _resolve_leave_records(body, tenant_id=_TENANT_ID, employees=employees)

    assert result == ()
    assert calls == 0


async def test_omitted_leave_records_pulls_via_grpc_scoped_to_the_resolved_roster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def _fake_get_unavailability(
        channel: object,
        *,
        tenant_id: uuid.UUID,
        employee_ids: tuple[uuid.UUID, ...],
        date_range_start: date,
        date_range_end: date,
    ) -> tuple[LeaveRecord, ...]:
        captured["tenant_id"] = tenant_id
        captured["employee_ids"] = employee_ids
        captured["date_range_start"] = date_range_start
        captured["date_range_end"] = date_range_end
        return (LeaveRecord(employee_id=_EMPLOYEE_ID, start=date(2026, 6, 10), end=date(2026, 6, 12)),)

    monkeypatch.setattr(_RESOLVER_TARGET, _fake_get_unavailability)

    body = _request(leave_records=None)
    employees = (Employee(id=_EMPLOYEE_ID, contract_hours_per_week=40.0),)

    result = await _resolve_leave_records(body, tenant_id=_TENANT_ID, employees=employees)

    assert result == (LeaveRecord(employee_id=_EMPLOYEE_ID, start=date(2026, 6, 10), end=date(2026, 6, 12)),)
    assert captured["tenant_id"] == _TENANT_ID
    assert captured["employee_ids"] == (_EMPLOYEE_ID,)
    assert captured["date_range_start"] == date(2026, 6, 1)
    assert captured["date_range_end"] == date(2026, 6, 30)
