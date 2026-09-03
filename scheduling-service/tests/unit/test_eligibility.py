"""Module 07's single-assignment eligibility check (docs/adr/0082,
`app/solver/eligibility.py`). Two categories of test:

1. Skill/leave/overlap/min-rest - `evaluate_assignment_eligibility` calls
   `_is_eligible`/`_conflicts` verbatim, so these mostly guard the wiring
   (category attribution, violation aggregation), not the predicates
   themselves (already covered by `test_solver_constraints.py`).
2. Max-consecutive-days/contracted-hours - the drift guard this module's own
   docstring promises: the same synthetic scenario is run through both the
   real CP-SAT `solve()` and `evaluate_assignment_eligibility`, asserting
   they agree on feasibility. A future change to either side's window/cap
   arithmetic that silently diverges from the other fails here.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from app.solver.eligibility import (
    CATEGORY_CONTRACTED_HOURS,
    CATEGORY_LEAVE_CONFLICT,
    CATEGORY_MAX_CONSECUTIVE_DAYS,
    CATEGORY_MIN_REST,
    CATEGORY_SHIFT_OVERLAP,
    CATEGORY_SKILL,
    evaluate_assignment_eligibility,
)
from app.solver.model import solve
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
)


def _emp(
    contract_hours: float = 40.0,
    overtime_approved: bool = False,
    skills: tuple[EmployeeSkill, ...] = (),
) -> Employee:
    return Employee(
        id=uuid.uuid4(), contract_hours_per_week=contract_hours, overtime_approved=overtime_approved,
        skills=skills,
    )


def _shift(day: date, start_hour: int, duration_hours: float, *, skill_id: uuid.UUID | None = None) -> ShiftSlot:
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    return ShiftSlot(
        id=uuid.uuid4(), start=start, end=start + timedelta(hours=duration_hours),
        required_headcount=1, required_skill_id=skill_id,
    )


# --- Skill / leave / overlap / min-rest: wiring around the reused predicates


def test_missing_skill_is_flagged() -> None:
    skill_id = uuid.uuid4()
    employee = _emp()
    shift = _shift(date(2026, 3, 2), 9, 8, skill_id=skill_id)
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=shift, existing_shifts=(), leave_records=(), policy=DEFAULT_POLICY
    )
    assert any(v.category == CATEGORY_SKILL for v in violations)


def test_leave_conflict_is_flagged_when_skill_present() -> None:
    employee = _emp()
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 8)
    leave = LeaveRecord(employee_id=employee.id, start=day, end=day)
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=shift, existing_shifts=(), leave_records=(leave,), policy=DEFAULT_POLICY
    )
    assert any(v.category == CATEGORY_LEAVE_CONFLICT for v in violations)
    assert not any(v.category == CATEGORY_SKILL for v in violations)


def test_overlapping_existing_shift_is_flagged_as_overlap() -> None:
    employee = _emp()
    day = date(2026, 3, 2)
    existing = _shift(day, 9, 8)
    candidate = _shift(day, 12, 8)
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=(existing,), leave_records=(),
        policy=DEFAULT_POLICY,
    )
    assert any(v.category == CATEGORY_SHIFT_OVERLAP for v in violations)


def test_insufficient_rest_between_non_overlapping_shifts_is_flagged() -> None:
    employee = _emp()
    day = date(2026, 3, 2)
    existing = _shift(day, 9, 8)  # ends 17:00
    candidate = _shift(day, 19, 8)  # starts 19:00 - only 2h gap, policy needs 10h
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=(existing,), leave_records=(),
        policy=DEFAULT_POLICY,
    )
    assert any(v.category == CATEGORY_MIN_REST for v in violations)


def test_fully_eligible_candidate_has_no_violations() -> None:
    employee = _emp()
    shift = _shift(date(2026, 3, 2), 9, 8)
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=shift, existing_shifts=(), leave_records=(), policy=DEFAULT_POLICY
    )
    assert violations == ()


# --- Drift guard: max-consecutive-days agrees with the real CP-SAT solve ---


def test_max_consecutive_days_matches_solver_infeasibility() -> None:
    employee = _emp()
    policy = EmploymentPolicy(
        max_consecutive_working_days=2, min_rest_hours_between_shifts=8.0, min_shift_length_minutes=240
    )
    start_day = date(2026, 3, 2)  # Monday
    already_worked = [_shift(start_day + timedelta(days=offset), 9, 8) for offset in range(2)]  # Mon, Tue
    candidate = _shift(start_day + timedelta(days=2), 9, 8)  # Wed - would make 3 in a row

    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=tuple(already_worked),
        leave_records=(), policy=policy,
    )
    assert any(v.category == CATEGORY_MAX_CONSECUTIVE_DAYS for v in violations)

    all_shifts = (*already_worked, candidate)
    result = solve(
        SolveInput(
            date_range_start=start_day,
            date_range_end=start_day + timedelta(days=2),
            employees=(employee,),
            shifts=all_shifts,
            policy=policy,
            locked_assignments=(),
        )
    )
    # Coverage requires headcount 1 on all three shifts with only one eligible
    # employee and a 2-consecutive-day cap - the solver must leave at least
    # one shift uncovered, i.e. infeasible under the strict `==` reading
    # coverage would need; `_add_coverage_constraints` uses `>=`, so with a
    # single employee who can cover at most 2 of the 3 shifts, coverage on
    # the third is unmet and the model is infeasible.
    assert result.status == "infeasible"


def test_max_consecutive_days_allows_a_fresh_streak() -> None:
    employee = _emp()
    policy = EmploymentPolicy(
        max_consecutive_working_days=2, min_rest_hours_between_shifts=8.0, min_shift_length_minutes=240
    )
    day = date(2026, 3, 2)
    candidate = _shift(day, 9, 8)
    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=(), leave_records=(), policy=policy
    )
    assert not any(v.category == CATEGORY_MAX_CONSECUTIVE_DAYS for v in violations)


# --- Drift guard: contracted-hours agrees with the real CP-SAT solve -------


def test_contracted_hours_matches_solver_infeasibility() -> None:
    employee = _emp(contract_hours=20.0, overtime_approved=False)
    monday = date(2026, 3, 2)
    already_worked = (_shift(monday, 9, 16),)  # 16h already this week
    candidate = _shift(monday + timedelta(days=1), 9, 8)  # +8h = 24h > 20h cap

    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=already_worked, leave_records=(),
        policy=DEFAULT_POLICY,
    )
    assert any(v.category == CATEGORY_CONTRACTED_HOURS for v in violations)

    result = solve(
        SolveInput(
            date_range_start=monday,
            date_range_end=monday + timedelta(days=1),
            employees=(employee,),
            shifts=(*already_worked, candidate),
            policy=DEFAULT_POLICY,
            locked_assignments=(),
        )
    )
    assert result.status == "infeasible"


def test_overtime_approved_employee_has_no_contracted_hours_cap() -> None:
    employee = _emp(contract_hours=20.0, overtime_approved=True)
    monday = date(2026, 3, 2)
    already_worked = (_shift(monday, 9, 16),)
    candidate = _shift(monday + timedelta(days=1), 9, 8)

    violations = evaluate_assignment_eligibility(
        candidate=employee, candidate_shift=candidate, existing_shifts=already_worked, leave_records=(),
        policy=DEFAULT_POLICY,
    )
    assert not any(v.category == CATEGORY_CONTRACTED_HOURS for v in violations)
