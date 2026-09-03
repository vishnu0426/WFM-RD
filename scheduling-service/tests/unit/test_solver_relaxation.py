"""§5/ADR-0057's relaxation-search correctness suite (Phase 4). Same
discipline as `test_solver_constraints.py`/
`test_solver_soft_constraints_and_fairness.py`: synthetic scenarios with a
known-correct expected outcome, run against the real search
(`app/solver/relaxation.py::search_relaxations`) and the real solver - no
mocking.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from app.solver.model import ShiftViolatesUnionRulesError, solve
from app.solver.relaxation import search_relaxations
from app.solver.types import (
    RELAXATION_CONTRACTED_HOURS,
    RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS,
    RELAXATION_MIN_REST_BETWEEN_SHIFTS,
    RELAXATION_SHIFT_LENGTH_BOUNDS,
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    ShiftSlot,
    SolveInput,
)

_POLICY = EmploymentPolicy(
    max_consecutive_working_days=6,
    min_rest_hours_between_shifts=10.0,
    min_shift_length_minutes=240,
    max_shift_length_minutes=600,
)


def _emp(
    *, contract_hours: float = 40.0, overtime_approved: bool = False, skills: tuple[EmployeeSkill, ...] = ()
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
) -> ShiftSlot:
    start = datetime(day.year, day.month, day.day, start_hour, tzinfo=UTC)
    return ShiftSlot(
        id=uuid.uuid4(),
        start=start,
        end=start + timedelta(hours=duration_hours),
        required_headcount=headcount,
        required_skill_id=skill_id,
    )


def test_search_is_a_noop_when_the_baseline_solve_is_already_feasible() -> None:
    """Not a real usage pattern (callers only invoke this after a baseline
    infeasible result), but proves the search itself doesn't misbehave if
    handed an already-feasible input - it still just runs the ladder and
    reports the first (cheapest) success, which here is immediate."""
    day = date(2026, 3, 2)
    result = search_relaxations(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(_emp(),),
            shifts=(_shift(day, 9, 4),),
            policy=_POLICY,
        )
    )
    assert result.feasible is True
    assert result.attempted_categories == (RELAXATION_CONTRACTED_HOURS,)


def test_search_finds_contracted_hours_as_the_cheapest_relaxation() -> None:
    day = date(2026, 3, 2)
    employee = _emp(contract_hours=4.0, overtime_approved=False)  # 240min/week cap
    shift = _shift(day, 9, 8)  # 480min - exceeds cap alone, only employee available
    result = search_relaxations(
        SolveInput(
            date_range_start=day, date_range_end=day, employees=(employee,), shifts=(shift,), policy=_POLICY
        )
    )
    assert result.feasible is True
    assert result.attempted_categories == (RELAXATION_CONTRACTED_HOURS,)
    assert result.result is not None
    assert result.result.status in {"optimal", "feasible"}
    cost = result.cost_summary[RELAXATION_CONTRACTED_HOURS]
    assert cost["employeesAffected"] == [str(employee.id)]
    assert cost["totalAdditionalOvertimeMinutes"] == 240
    assert "overtime" in result.explanation.lower()


def test_search_escalates_past_contracted_hours_to_minimum_rest() -> None:
    day = date(2026, 3, 2)
    employee = _emp()  # plenty of contract hours - relaxing hours won't help
    # Two 4h shifts, only 1h gap - violates the 10h min-rest policy. Only
    # one employee exists, so coverage forces both onto them.
    morning = _shift(day, 6, 4)
    evening = _shift(day, 11, 4)
    result = search_relaxations(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(morning, evening),
            policy=_POLICY,
        )
    )
    assert result.feasible is True
    # contracted_hours and shift_length_bounds are both no-ops for this
    # scenario (nothing about it involves either), so the search passes
    # through them before reaching the category that actually matters.
    assert result.attempted_categories == (
        RELAXATION_CONTRACTED_HOURS,
        RELAXATION_SHIFT_LENGTH_BOUNDS,
        RELAXATION_MIN_REST_BETWEEN_SHIFTS,
    )
    cost = result.cost_summary[RELAXATION_MIN_REST_BETWEEN_SHIFTS]
    assert len(cost["employeesAffected"]) == 1
    assert cost["details"][0]["actualRestHours"] < cost["details"][0]["requiredRestHours"]


def test_search_reaches_max_consecutive_days_as_the_last_resort() -> None:
    policy = EmploymentPolicy(
        max_consecutive_working_days=2, min_rest_hours_between_shifts=10.0, min_shift_length_minutes=240
    )
    start = date(2026, 3, 2)
    days = [start + timedelta(days=i) for i in range(3)]
    employee = _emp()
    shifts = tuple(_shift(d, 9, 4) for d in days)  # 3 straight required workdays, cap is 2
    result = search_relaxations(
        SolveInput(
            date_range_start=start,
            date_range_end=days[-1],
            employees=(employee,),
            shifts=shifts,
            policy=policy,
        )
    )
    assert result.feasible is True
    assert result.attempted_categories == (
        RELAXATION_CONTRACTED_HOURS,
        RELAXATION_SHIFT_LENGTH_BOUNDS,
        RELAXATION_MIN_REST_BETWEEN_SHIFTS,
        RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS,
    )
    cost = result.cost_summary[RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS]
    assert cost["details"][0]["consecutiveDaysWorked"] == 3
    assert cost["details"][0]["allowedMax"] == 2


def test_search_reports_infeasible_when_every_relaxation_is_exhausted() -> None:
    """Skill requirement is never a relaxation candidate (ADR-0057) - no
    combination of the four relaxable categories can ever fix a shift no
    one is qualified for."""
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    unqualified = _emp()
    shift = _shift(day, 9, 4, skill_id=skill_id)
    result = search_relaxations(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(unqualified,),
            shifts=(shift,),
            policy=_POLICY,
        )
    )
    assert result.feasible is False
    assert result.result is None
    assert len(result.attempted_categories) == 4
    assert "never relaxed automatically" in result.explanation
    assert "Skill" in result.explanation


def test_shift_length_bounds_relaxation_allows_an_otherwise_invalid_shift_when_used_directly() -> None:
    """ADR-0057's documented structural gap: this relaxation is correct in
    isolation but the search never reaches a scenario needing it, because a
    too-short shift is rejected before any solve, not discovered as an
    infeasibility. Exercised directly here so the mechanism itself is
    proven, independent of whether the search can currently reach it."""
    day = date(2026, 3, 2)
    too_short = _shift(day, 9, 1)  # 1h < 240min minimum
    employee = _emp()

    with pytest.raises(ShiftViolatesUnionRulesError):
        solve(
            SolveInput(
                date_range_start=day,
                date_range_end=day,
                employees=(employee,),
                shifts=(too_short,),
                policy=_POLICY,
            )
        )

    relaxed_result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(too_short,),
            policy=_POLICY,
            relaxed_categories=frozenset({RELAXATION_SHIFT_LENGTH_BOUNDS}),
        )
    )
    assert relaxed_result.status in {"optimal", "feasible"}
