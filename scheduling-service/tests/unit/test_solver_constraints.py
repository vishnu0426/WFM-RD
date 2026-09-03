"""§8's constraint-correctness test suite: one synthetic scenario per §3.1
hard constraint with a known-correct expected outcome, run against the real
CP-SAT model (no mocking of the solver itself - only the input data is
synthetic). This is the suite the module prompt asks to exist "so a
regression in constraint modeling is caught before it becomes a labor-law
violation in production, not after." No database, no HTTP - `app.solver` is
deliberately pure (see its own module docstring).
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from app.solver.model import ShiftViolatesUnionRulesError, solve
from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    LeaveRecord,
    ShiftSlot,
    SolveInput,
)

_FEASIBLE = {"optimal", "feasible"}

DEFAULT_POLICY = EmploymentPolicy(
    max_consecutive_working_days=5,
    min_rest_hours_between_shifts=10.0,
    min_shift_length_minutes=240,
    max_shift_length_minutes=600,
    mandatory_break_after_hours=6.0,
    mandatory_break_minutes=30,
)


def _emp(
    contract_hours: float = 40.0,
    overtime_approved: bool = False,
    skills: tuple[EmployeeSkill, ...] = (),
) -> Employee:
    return Employee(
        id=uuid.uuid4(),
        contract_hours_per_week=contract_hours,
        overtime_approved=overtime_approved,
        skills=skills,
    )


def _shift(
    day: date,
    start_hour: int,
    duration_hours: float,
    *,
    headcount: int = 1,
    skill_id: uuid.UUID | None = None,
    break_minutes: int = 0,
) -> ShiftSlot:
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    return ShiftSlot(
        id=uuid.uuid4(),
        start=start,
        end=start + timedelta(hours=duration_hours),
        required_headcount=headcount,
        required_skill_id=skill_id,
        break_minutes=break_minutes,
    )


# --- Coverage (structural precondition, §3.1 preamble) ---------------------


def test_coverage_is_met_when_enough_eligible_employees_exist() -> None:
    day = date(2026, 3, 2)
    e1, e2 = _emp(), _emp()
    shift = _shift(day, 9, 8, headcount=2, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(e1, e2),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {e1.id, e2.id}


def test_infeasible_when_not_enough_employees_to_meet_coverage() -> None:
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 8, headcount=2, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status == "infeasible"
    assert result.assignments == ()


# --- Skill requirement -------------------------------------------------


def test_skill_requirement_excludes_employees_without_a_current_certification() -> None:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    qualified = _emp(skills=(EmployeeSkill(skill_id=skill_id, expires_at=None),))
    expired = _emp(skills=(EmployeeSkill(skill_id=skill_id, expires_at=day - timedelta(days=1)),))
    unskilled = _emp()
    shift = _shift(day, 9, 8, headcount=1, skill_id=skill_id, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(expired, unskilled, qualified),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {qualified.id}


def test_skill_requirement_is_infeasible_when_no_one_qualifies() -> None:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    shift = _shift(day, 9, 8, headcount=1, skill_id=skill_id, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status == "infeasible"


# --- Leave / unavailability (ADR-0055's interim source) --------------------


def test_leave_blocks_assignment_during_the_leave_window() -> None:
    day = date(2026, 3, 2)
    on_leave, available = _emp(), _emp()
    shift = _shift(day, 9, 8, headcount=1, break_minutes=30)
    leave = LeaveRecord(employee_id=on_leave.id, start=day, end=day)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(on_leave, available),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            leave_records=(leave,),
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {available.id}


def test_leave_makes_the_shift_infeasible_when_the_only_eligible_employee_is_on_leave() -> None:
    day = date(2026, 3, 2)
    on_leave = _emp()
    shift = _shift(day, 9, 8, headcount=1, break_minutes=30)
    leave = LeaveRecord(employee_id=on_leave.id, start=day, end=day)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(on_leave,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            leave_records=(leave,),
        )
    )
    assert result.status == "infeasible"


# --- Labor law: minimum rest between shifts / no double-booking ------------


def test_overlapping_shifts_cannot_be_assigned_to_the_same_employee() -> None:
    day = date(2026, 3, 2)
    shift_a = _shift(day, 9, 4)  # 09:00-13:00
    shift_b = _shift(day, 11, 4)  # 11:00-15:00, overlaps shift_a
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(shift_a, shift_b),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status == "infeasible"


def test_insufficient_rest_between_shifts_is_infeasible_for_a_single_employee() -> None:
    day = date(2026, 3, 2)
    morning = _shift(day, 6, 8, break_minutes=30)  # 06:00-14:00
    evening = _shift(day, 15, 8, break_minutes=30)  # 15:00-23:00 - 1h gap, min rest is 10h
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(morning, evening),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status == "infeasible"


def test_sufficient_rest_between_shifts_allows_the_same_employee_to_work_both() -> None:
    day1, day2 = date(2026, 3, 2), date(2026, 3, 3)
    employee = _emp()
    shift1 = _shift(day1, 6, 8, break_minutes=30)  # ends 14:00
    shift2 = _shift(day2, 6, 8, break_minutes=30)  # starts next day 06:00 - 16h gap
    result = solve(
        SolveInput(
            date_range_start=day1,
            date_range_end=day2,
            employees=(employee,),
            shifts=(shift1, shift2),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.shift_id for a in result.assignments} == {shift1.id, shift2.id}


# --- Labor law: maximum consecutive working days ----------------------


def test_max_consecutive_working_days_forces_infeasibility_without_a_rest_day() -> None:
    policy = replace(DEFAULT_POLICY, max_consecutive_working_days=2)
    start = date(2026, 3, 2)
    days = [start + timedelta(days=i) for i in range(3)]
    shifts = tuple(_shift(d, 9, 4) for d in days)  # 3 straight required workdays, cap is 2
    result = solve(
        SolveInput(
            date_range_start=start, date_range_end=days[-1], employees=(_emp(),), shifts=shifts, policy=policy
        )
    )
    assert result.status == "infeasible"


def test_max_consecutive_working_days_allows_a_schedule_with_a_rest_day_inside_the_window() -> None:
    policy = replace(DEFAULT_POLICY, max_consecutive_working_days=2)
    start = date(2026, 3, 2)
    d0, d1, d2 = (
        start,
        start + timedelta(days=1),
        start + timedelta(days=3),
    )  # gap at index 2 - no 3-day window is fully worked
    employee = _emp()
    shifts = (_shift(d0, 9, 4), _shift(d1, 9, 4), _shift(d2, 9, 4))
    result = solve(
        SolveInput(
            date_range_start=start, date_range_end=d2, employees=(employee,), shifts=shifts, policy=policy
        )
    )
    assert result.status in _FEASIBLE
    assert len(result.assignments) == 3


# --- Contracted hours (overtime-approval flag) --------------------------


def test_contracted_hours_cap_blocks_scheduling_beyond_contract_without_overtime_approval() -> None:
    day = date(2026, 3, 2)
    employee = _emp(contract_hours=4.0, overtime_approved=False)  # 240min/week cap
    shift = _shift(day, 6, 8, break_minutes=30)  # 480min shift - exceeds the weekly cap on its own
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status == "infeasible"


def test_overtime_approved_employee_can_exceed_contract_hours_and_is_flagged() -> None:
    day = date(2026, 3, 2)
    employee = _emp(contract_hours=4.0, overtime_approved=True)
    shift = _shift(day, 6, 8, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert len(result.assignments) == 1
    assert result.assignments[0].is_overtime is True


# --- Union rules: shift-template validation (pre-solve, not a CP-SAT term) -


def test_shift_shorter_than_minimum_length_is_rejected_before_solving() -> None:
    day = date(2026, 3, 2)
    short_shift = _shift(day, 9, 1)  # 1h < 240min minimum
    with pytest.raises(ShiftViolatesUnionRulesError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(_emp(),),
                shifts=(short_shift,),
                policy=DEFAULT_POLICY,
            )
        )


def test_shift_longer_than_maximum_length_is_rejected_before_solving() -> None:
    day = date(2026, 3, 2)
    long_shift = _shift(day, 6, 11, break_minutes=30)  # 11h > 600min (10h) maximum
    with pytest.raises(ShiftViolatesUnionRulesError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(_emp(),),
                shifts=(long_shift,),
                policy=DEFAULT_POLICY,
            )
        )


def test_shift_over_the_break_threshold_without_a_break_is_rejected() -> None:
    day = date(2026, 3, 2)
    no_break_shift = _shift(day, 9, 8, break_minutes=0)  # 8h > 6h mandatory-break threshold
    with pytest.raises(ShiftViolatesUnionRulesError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(_emp(),),
                shifts=(no_break_shift,),
                policy=DEFAULT_POLICY,
            )
        )


def test_shift_over_the_break_threshold_with_sufficient_break_is_accepted() -> None:
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 8, break_minutes=30)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
        )
    )
    assert result.status in _FEASIBLE
