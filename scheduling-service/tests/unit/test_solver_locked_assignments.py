"""ADR-0058's locked-assignment correctness suite: one synthetic scenario per
rule (forced variable, effective-cap/window adjustment, locked-locked
conflict skip, eligibility bypass, unknown-reference validation) run against
the real CP-SAT model - same "no mocking the solver itself" posture as
tests/unit/test_solver_constraints.py.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import pytest

from app.solver.model import UnknownLockedAssignmentError, solve
from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    LeaveRecord,
    LockedAssignment,
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


# --- Basic forcing -----------------------------------------------------


def test_locked_assignment_is_forced_into_the_result_even_when_not_the_cheapest_choice() -> None:
    day = date(2026, 3, 2)
    cheap, expensive = _emp(), _emp()
    shift = _shift(day, 9, 4)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(cheap, expensive),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            locked_assignments=(LockedAssignment(employee_id=expensive.id, shift_id=shift.id),),
        )
    )
    assert result.status in _FEASIBLE
    assert len(result.assignments) == 1  # coverage headcount is 1
    assert result.assignments[0].employee_id == expensive.id


def test_unknown_locked_employee_raises_before_solving() -> None:
    day = date(2026, 3, 2)
    employee = _emp()
    shift = _shift(day, 9, 4)
    stranger_id = uuid.uuid4()
    with pytest.raises(UnknownLockedAssignmentError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(employee,),
                shifts=(shift,),
                policy=DEFAULT_POLICY,
                locked_assignments=(LockedAssignment(employee_id=stranger_id, shift_id=shift.id),),
            )
        )


def test_unknown_locked_shift_raises_before_solving() -> None:
    day = date(2026, 3, 2)
    employee = _emp()
    shift = _shift(day, 9, 4)
    stranger_shift_id = uuid.uuid4()
    with pytest.raises(UnknownLockedAssignmentError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(employee,),
                shifts=(shift,),
                policy=DEFAULT_POLICY,
                locked_assignments=(LockedAssignment(employee_id=employee.id, shift_id=stranger_shift_id),),
            )
        )


# --- Eligibility bypass (skill requirement / leave) ---------------------


def test_locked_assignment_bypasses_skill_requirement() -> None:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    unskilled = _emp()  # no EmployeeSkill for skill_id
    shift = _shift(day, 9, 4, skill_id=skill_id)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(unskilled,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            locked_assignments=(LockedAssignment(employee_id=unskilled.id, shift_id=shift.id),),
        )
    )
    assert result.status in _FEASIBLE
    assert result.assignments[0].employee_id == unskilled.id


def test_locked_assignment_bypasses_leave_unavailability() -> None:
    day = date(2026, 3, 2)
    employee = _emp()
    shift = _shift(day, 9, 4)
    leave = LeaveRecord(employee_id=employee.id, start=day, end=day)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            leave_records=(leave,),
            locked_assignments=(LockedAssignment(employee_id=employee.id, shift_id=shift.id),),
        )
    )
    assert result.status in _FEASIBLE
    assert result.assignments[0].employee_id == employee.id


# --- Locked-locked conflict skip (min rest / double-booking) -----------


def test_two_locked_overlapping_shifts_for_the_same_employee_do_not_block_the_model() -> None:
    day = date(2026, 3, 2)
    employee = _emp()
    shift_a = _shift(day, 9, 4)  # 09:00-13:00
    shift_b = _shift(day, 11, 4)  # 11:00-15:00, overlaps shift_a
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift_a, shift_b),
            policy=DEFAULT_POLICY,
            locked_assignments=(
                LockedAssignment(employee_id=employee.id, shift_id=shift_a.id),
                LockedAssignment(employee_id=employee.id, shift_id=shift_b.id),
            ),
        )
    )
    assert result.status in _FEASIBLE
    assert {a.shift_id for a in result.assignments} == {shift_a.id, shift_b.id}


def test_locked_shift_still_conflicts_with_a_solvable_shift_for_the_same_employee() -> None:
    day = date(2026, 3, 2)
    only_employee = _emp()
    shift_a = _shift(day, 9, 4)  # 09:00-13:00, locked
    shift_b = _shift(day, 11, 4, headcount=1)  # 11:00-15:00, overlaps shift_a, must be covered
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(only_employee,),
            shifts=(shift_a, shift_b),
            policy=DEFAULT_POLICY,
            locked_assignments=(LockedAssignment(employee_id=only_employee.id, shift_id=shift_a.id),),
        )
    )
    # shift_a is forced onto the only employee; shift_b needs coverage from
    # someone, but the only employee available conflicts with their own
    # locked shift, so shift_b can never be covered - infeasible, not
    # silently skipped.
    assert result.status == "infeasible"


# --- Effective max-consecutive-days window -------------------------------


def test_locked_streak_beyond_the_policy_max_does_not_block_the_model() -> None:
    policy = replace(DEFAULT_POLICY, max_consecutive_working_days=2)
    start = date(2026, 3, 2)
    days = [start + timedelta(days=i) for i in range(3)]
    employee = _emp()
    shifts = tuple(_shift(d, 9, 4) for d in days)  # 3 straight days, locked, cap is 2
    result = solve(
        SolveInput(
            date_range_start=start,
            date_range_end=days[-1],
            employees=(employee,),
            shifts=shifts,
            policy=policy,
            locked_assignments=tuple(
                LockedAssignment(employee_id=employee.id, shift_id=s.id) for s in shifts
            ),
        )
    )
    assert result.status in _FEASIBLE
    assert {a.shift_id for a in result.assignments} == {s.id for s in shifts}


def test_locked_streak_still_caps_additional_solvable_days_at_the_policy_max() -> None:
    policy = replace(DEFAULT_POLICY, max_consecutive_working_days=2)
    start = date(2026, 3, 2)
    d0, d1, d2 = start, start + timedelta(days=1), start + timedelta(days=2)
    employee = _emp()
    other = _emp()
    locked_shifts = (_shift(d0, 9, 4), _shift(d1, 9, 4))  # locked streak of 2, meets the cap already
    extra_shift = _shift(d2, 9, 4, headcount=1)  # a 3rd straight day - must be covered by someone
    result = solve(
        SolveInput(
            date_range_start=start,
            date_range_end=d2,
            employees=(employee, other),
            shifts=(*locked_shifts, extra_shift),
            policy=policy,
            locked_assignments=tuple(
                LockedAssignment(employee_id=employee.id, shift_id=s.id) for s in locked_shifts
            ),
        )
    )
    assert result.status in _FEASIBLE
    # the locked employee's window is already at the effective max (2); the
    # 3rd straight day must fall to the other employee, not extend the
    # locked employee's own streak.
    extra_assignment = next(a for a in result.assignments if a.shift_id == extra_shift.id)
    assert extra_assignment.employee_id == other.id


# --- Effective contracted-hours cap --------------------------------------


def test_locked_assignment_beyond_the_contract_cap_does_not_block_the_model() -> None:
    day = date(2026, 3, 2)
    employee = _emp(contract_hours=4.0, overtime_approved=False)  # 240min/week cap
    shift = _shift(day, 6, 8, break_minutes=30)  # 480min - exceeds the cap on its own, but locked
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift,),
            policy=DEFAULT_POLICY,
            locked_assignments=(LockedAssignment(employee_id=employee.id, shift_id=shift.id),),
        )
    )
    assert result.status in _FEASIBLE
    assert result.assignments[0].employee_id == employee.id


def test_locked_hours_still_cap_additional_solvable_hours_that_week() -> None:
    day = date(2026, 3, 2)
    next_day = day + timedelta(days=1)
    employee = _emp(contract_hours=4.0, overtime_approved=False)  # 240min/week cap
    other = _emp(contract_hours=40.0)
    locked_shift = _shift(day, 6, 8, break_minutes=30)  # 480min, locked - already over the cap
    extra_shift = _shift(next_day, 6, 4, headcount=1)  # same calendar week, needs coverage
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=next_day,
            employees=(employee, other),
            shifts=(locked_shift, extra_shift),
            policy=DEFAULT_POLICY,
            locked_assignments=(LockedAssignment(employee_id=employee.id, shift_id=locked_shift.id),),
        )
    )
    assert result.status in _FEASIBLE
    # the capped employee's effective cap this week is already consumed by
    # the locked shift; the extra shift must fall to the other employee.
    extra_assignment = next(a for a in result.assignments if a.shift_id == extra_shift.id)
    assert extra_assignment.employee_id == other.id
