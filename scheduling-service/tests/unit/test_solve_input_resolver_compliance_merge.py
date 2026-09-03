"""§0.6/ADR-0102: `_merge_compliance_floor`'s stricter-wins-per-field logic.
Monkeypatches `calendar_client.get_org_unit_country_code`/
`compliance_client.get_active_rule_definition` directly (both already have
their own dedicated client-level tests, `test_calendar_client.py`/
`test_compliance_client.py`) - this file is about the merge arithmetic
itself, not the gRPC plumbing underneath it.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.services import solve_input_resolver
from app.solver.types import EmploymentPolicy

_TENANT_ID = uuid.uuid4()
_ORG_UNIT_ID = uuid.uuid4()
_AS_OF = date(2026, 6, 1)

_BASE_POLICY = EmploymentPolicy(
    max_consecutive_working_days=6,
    min_rest_hours_between_shifts=8.0,
    min_shift_length_minutes=120,
    max_shift_length_minutes=480,
    mandatory_break_after_hours=6.0,
    mandatory_break_minutes=15,
)


def _patch_country_code(monkeypatch: pytest.MonkeyPatch, country_code: str | None) -> None:
    async def _fake(
        channel: object, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, as_of: date
    ) -> str | None:
        return country_code

    monkeypatch.setattr("app.services.solve_input_resolver.calendar_client.get_org_unit_country_code", _fake)


def _patch_floors(monkeypatch: pytest.MonkeyPatch, floors: dict[str, dict[str, object]]) -> None:
    async def _fake(
        channel: object, *, tenant_id: uuid.UUID, jurisdiction: str, rule_type: str, as_of: date
    ) -> dict[str, object] | None:
        return floors.get(rule_type)

    monkeypatch.setattr(
        "app.services.solve_input_resolver.compliance_client.get_active_rule_definition", _fake
    )


async def test_no_resolvable_jurisdiction_returns_the_policy_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_country_code(monkeypatch, None)
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result == _BASE_POLICY


async def test_no_floor_rules_at_all_returns_the_policy_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_country_code(monkeypatch, "US")
    _patch_floors(monkeypatch, {})
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result == _BASE_POLICY


async def test_a_stricter_rest_floor_overrides_the_policys_own_value(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_country_code(monkeypatch, "US-CA")
    _patch_floors(monkeypatch, {"rest_period_minimum": {"minRestHoursBetweenShifts": 10}})
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result.min_rest_hours_between_shifts == 10
    # Every other field is untouched - no floor rule was configured for it.
    assert result.max_consecutive_working_days == _BASE_POLICY.max_consecutive_working_days


async def test_a_looser_rest_floor_never_weakens_the_policys_own_stricter_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_country_code(monkeypatch, "US")
    _patch_floors(monkeypatch, {"rest_period_minimum": {"minRestHoursBetweenShifts": 6}})
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert (
        result.min_rest_hours_between_shifts == _BASE_POLICY.min_rest_hours_between_shifts
    )  # 8.0, stricter than 6


async def test_a_stricter_max_consecutive_days_floor_lowers_the_policys_own_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_country_code(monkeypatch, "FR")
    _patch_floors(monkeypatch, {"max_consecutive_days": {"maxConsecutiveWorkingDays": 5}})
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result.max_consecutive_working_days == 5


async def test_union_rule_floor_can_introduce_a_cap_the_base_policy_never_had(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`max_shift_length_minutes`/`mandatory_break_after_hours`/`mandatory_break_minutes`
    are all Optional on `EmploymentPolicy` - a floor that specifies one must
    win outright when the base policy left it unset (`None` is never
    stricter than a real number)."""
    policy_with_no_caps = EmploymentPolicy(
        max_consecutive_working_days=6,
        min_rest_hours_between_shifts=8.0,
        min_shift_length_minutes=120,
        max_shift_length_minutes=None,
        mandatory_break_after_hours=None,
        mandatory_break_minutes=None,
    )
    _patch_country_code(monkeypatch, "DE")
    _patch_floors(
        monkeypatch,
        {
            "union_rule": {
                "maxShiftLengthMinutes": 600,
                "mandatoryBreakAfterHours": 5,
                "mandatoryBreakMinutes": 30,
            }
        },
    )
    result = await solve_input_resolver._merge_compliance_floor(
        policy_with_no_caps, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result.max_shift_length_minutes == 600
    assert result.mandatory_break_after_hours == 5
    assert result.mandatory_break_minutes == 30


async def test_all_four_rule_types_merge_independently_in_one_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_country_code(monkeypatch, "US-NY")
    _patch_floors(
        monkeypatch,
        {
            "rest_period_minimum": {"minRestHoursBetweenShifts": 11},
            "max_consecutive_days": {"maxConsecutiveWorkingDays": 5},
            "union_rule": {"minShiftLengthMinutes": 180},
        },
    )
    result = await solve_input_resolver._merge_compliance_floor(
        _BASE_POLICY, tenant_id=_TENANT_ID, org_unit_id=_ORG_UNIT_ID, as_of=_AS_OF
    )
    assert result.min_rest_hours_between_shifts == 11
    assert result.max_consecutive_working_days == 5
    assert result.min_shift_length_minutes == 180  # stricter than the base policy's 120
    assert result.max_shift_length_minutes == _BASE_POLICY.max_shift_length_minutes  # no floor for this field


@pytest.mark.parametrize(
    ("policy_value", "floor_value", "expected"),
    [
        (10.0, 8, 8.0),  # floor is stricter (lower)
        (5.0, 8, 5.0),  # policy already stricter
        (None, 8, 8.0),  # no policy value at all - floor wins outright
        (5.0, "not-a-number", 5.0),  # malformed floor value is ignored, not coerced
        (5.0, None, 5.0),  # floor has no opinion on this field
    ],
)
def test_stricter_lower_helper(policy_value: float | None, floor_value: object, expected: float) -> None:
    assert solve_input_resolver._stricter_lower(policy_value, floor_value) == expected


@pytest.mark.parametrize(
    ("policy_value", "floor_value", "expected"),
    [
        (8.0, 10, 10.0),  # floor is stricter (higher)
        (12.0, 10, 12.0),  # policy already stricter
        (None, 10, 10.0),  # no policy value at all - floor wins outright
    ],
)
def test_stricter_higher_helper(policy_value: float | None, floor_value: object, expected: float) -> None:
    assert solve_input_resolver._stricter_higher(policy_value, floor_value) == expected
