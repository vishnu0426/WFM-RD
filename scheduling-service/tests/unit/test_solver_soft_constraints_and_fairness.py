"""§8-style correctness suite for Phase 3: §3.2's soft constraints (as real
trade-offs the objective must actually make, not just accept as input
without effect) and §3.3's fairness bound (as a real CP-SAT constraint that
can genuinely make a job infeasible, not a tradeable preference). Same
discipline as `test_solver_constraints.py`: synthetic scenarios, known-
correct expected outcomes, solved for real.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from app.solver.model import solve
from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    FairnessConfig,
    ShiftSlot,
    SoftWeights,
    SolveInput,
)

_FEASIBLE = {"optimal", "feasible"}

_POLICY = EmploymentPolicy(
    max_consecutive_working_days=6,
    min_rest_hours_between_shifts=10.0,
    min_shift_length_minutes=240,
    max_shift_length_minutes=600,
)


def _emp(
    *,
    contract_hours: float = 40.0,
    overtime_approved: bool = False,
    skills: tuple[EmployeeSkill, ...] = (),
    preferred_shift_ids: frozenset[uuid.UUID] = frozenset(),
) -> Employee:
    return Employee(
        id=uuid.uuid4(),
        contract_hours_per_week=contract_hours,
        overtime_approved=overtime_approved,
        skills=skills,
        preferred_shift_ids=preferred_shift_ids,
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


# --- §3.2: employee shift preference ----------------------------------


def test_preference_soft_term_prefers_the_employees_preferred_shift() -> None:
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 4)
    preferring = _emp(preferred_shift_ids=frozenset({shift.id}))
    indifferent = _emp()
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(preferring, indifferent),
            shifts=(shift,),
            policy=_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {preferring.id}


# --- §3.2: cost minimization (avoid overtime when avoidable) ---------------


def test_overtime_cost_objective_avoids_overtime_when_a_non_overtime_alternative_exists() -> None:
    day = date(2026, 3, 2)
    low_cap_approved = _emp(contract_hours=4.0, overtime_approved=True)  # 240min/week cap
    high_cap_not_approved = _emp(contract_hours=40.0, overtime_approved=False)
    # 4h each, exactly `min_rest_hours_between_shifts` (10h) apart - feasible
    # for one employee to work both from a rest standpoint, so only the
    # contract-hours cap decides whether concentrating both on
    # `low_cap_approved` (240min cap, would total 480min -> overtime) is
    # avoided in favor of splitting/using the uncapped employee instead.
    shift1 = _shift(day, 6, 4)
    shift2 = _shift(day, 20, 4)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(low_cap_approved, high_cap_not_approved),
            shifts=(shift1, shift2),
            policy=_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert len(result.assignments) == 2
    assert not any(a.is_overtime for a in result.assignments)


# --- §3.2: skill decay (prefer fresher proficiency) -------------------


def test_skill_decay_soft_term_prefers_the_less_decayed_employee() -> None:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    fresh = _emp(skills=(EmployeeSkill(skill_id=skill_id, decay_score=0.0),))
    decayed = _emp(skills=(EmployeeSkill(skill_id=skill_id, decay_score=0.9),))
    shift = _shift(day, 9, 4, skill_id=skill_id)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(decayed, fresh),
            shifts=(shift,),
            policy=_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {fresh.id}


# --- §3.2: cross-skill balance -----------------------------------------


def test_cross_skill_balance_soft_term_spreads_a_skill_across_distinct_employees() -> None:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    emp_a = _emp(skills=(EmployeeSkill(skill_id=skill_id),))
    emp_b = _emp(skills=(EmployeeSkill(skill_id=skill_id),))
    # Non-conflicting times so either employee could take either or both.
    shift1 = _shift(day, 6, 4, skill_id=skill_id)
    shift2 = _shift(day, 20, 4, skill_id=skill_id)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(emp_a, emp_b),
            shifts=(shift1, shift2),
            policy=_POLICY,
        )
    )
    assert result.status in _FEASIBLE
    assert {a.employee_id for a in result.assignments} == {emp_a.id, emp_b.id}


# --- §3.3: fairness bound is a hard constraint ------------------------


def test_fairness_bound_is_infeasible_when_tolerance_cannot_absorb_existing_imbalance() -> None:
    day = date(2026, 3, 2)
    already_burdened = _emp()
    fresh_start = _emp()
    night_shift = _shift(day, 23, 4)  # 23:00-03:00 - "undesirable" under the night rule below
    fairness = FairnessConfig(rolling_period_weeks=4, tolerance=0, night_start_hour=22, night_end_hour=6)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(already_burdened, fresh_start),
            shifts=(night_shift,),
            policy=_POLICY,
            fairness=fairness,
            fairness_history_counts={already_burdened.id: 3, fresh_start.id: 0},
        )
    )
    # Whoever gets the shift, the group total (3 or 4) can never split
    # evenly across 2 people with zero tolerance - structurally infeasible,
    # not a bug in either the scenario or the constraint.
    assert result.status == "infeasible"


def test_fairness_bound_is_satisfiable_within_a_reasonable_tolerance() -> None:
    day = date(2026, 3, 2)
    already_burdened = _emp()
    fresh_start = _emp()
    night_shift = _shift(day, 23, 4)
    fairness = FairnessConfig(rolling_period_weeks=4, tolerance=2, night_start_hour=22, night_end_hour=6)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(already_burdened, fresh_start),
            shifts=(night_shift,),
            policy=_POLICY,
            fairness=fairness,
            fairness_history_counts={already_burdened.id: 3, fresh_start.id: 0},
        )
    )
    assert result.status in _FEASIBLE


def test_fairness_bound_is_a_noop_when_fairness_is_none() -> None:
    """Phase 2's original behavior, unchanged: an imbalanced assignment is
    still accepted when the caller doesn't opt into §3.3 at all."""
    day = date(2026, 3, 2)
    already_burdened = _emp()
    night_shift = _shift(day, 23, 4)
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(already_burdened,),
            shifts=(night_shift,),
            policy=_POLICY,
            fairness_history_counts={already_burdened.id: 100},
        )
    )
    assert result.status in _FEASIBLE


# --- Objective bookkeeping -----------------------------------------------


def test_objective_value_is_populated_when_a_soft_term_applies() -> None:
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 4)
    preferring = _emp(preferred_shift_ids=frozenset({shift.id}))
    result = solve(
        SolveInput(
            date_range_start=day, date_range_end=day, employees=(preferring,), shifts=(shift,), policy=_POLICY
        )
    )
    assert result.status in _FEASIBLE
    assert result.objective_value is not None
    assert result.objective_value > 0


def test_objective_value_is_none_when_no_soft_term_could_ever_apply() -> None:
    day = date(2026, 3, 2)
    shift = _shift(day, 9, 4)
    employee = _emp()
    result = solve(
        SolveInput(
            date_range_start=day,
            date_range_end=day,
            employees=(employee,),
            shifts=(shift,),
            policy=_POLICY,
            soft_weights=SoftWeights(
                preference_weight=0,
                overtime_cost_weight=0,
                skill_decay_weight=0,
                cross_skill_balance_weight=0,
            ),
        )
    )
    assert result.status in _FEASIBLE
    assert result.objective_value is None
