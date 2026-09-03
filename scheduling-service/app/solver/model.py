"""§3.1's hard-constraint CP-SAT model (Phase 2) plus §3.2's soft constraints
and §3.3's fairness bound (Phase 3), single-site/non-decomposed scope.

Every §3.1 constraint is encoded so CP-SAT *cannot* return a solution that
violates it - per the module prompt's own non-negotiable, none of them are
weighted objective terms. §3.3's fairness bound is held to the exact same
standard: it is a real constraint (`_add_fairness_constraint`), not a
tradeable objective term, even though it lives in the same phase as the
soft constraints that *are* objective terms - the module prompt is explicit
that fairness gets this treatment ("not purely an objective term alone").

Constraint-to-code map (§3.1's table):
- Labor law compliance (max consecutive days, min rest) -> `_add_no_conflict_constraints`
  (min rest) + `_add_max_consecutive_days_constraints` (max consecutive days).
- Contracted hours -> `_add_contracted_hours_constraints`.
- Skill requirement -> eligibility gating in `_is_eligible` (an ineligible
  employee gets no decision variable for that shift at all - structurally
  cannot be assigned, not merely discouraged).
- Leave/unavailability -> also `_is_eligible` (ADR-0055's interim source).
- Union rules (min/max shift length, mandatory break) -> `_validate_shifts`,
  a pre-solve structural validation of the shift *template*, not a decision
  variable - see that function's docstring for why.

§3.2's soft constraints -> `_build_objective_terms`: employee preference
(reward), overtime cost (penalize, via `_add_overtime_penalty_vars`), skill
decay (penalize fresher-is-better), cross-skill balance (reward spreading a
skill across more distinct employees, via `_cross_skill_balance_vars`).

§3.3's fairness bound -> `_add_fairness_constraint`: bounds each roster
employee's undesirable-shift count (prior published history, from the
`FairnessLedger` via `SolveInput.fairness_history_counts`, plus this solve's
own assignments) to within `tolerance` of the roster's own average.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import date, timedelta
from typing import Any

from ortools.sat.python import cp_model

from app.solver.types import (
    RELAXATION_CONTRACTED_HOURS,
    RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS,
    RELAXATION_MIN_REST_BETWEEN_SHIFTS,
    RELAXATION_SHIFT_LENGTH_BOUNDS,
    Assignment,
    Employee,
    EmploymentPolicy,
    FairnessConfig,
    LeaveRecord,
    ShiftSlot,
    SoftWeights,
    SolveInput,
    SolveResult,
)

_STATUS_NAMES = {
    cp_model.OPTIMAL: "optimal",
    cp_model.FEASIBLE: "feasible",
    cp_model.INFEASIBLE: "infeasible",
    cp_model.UNKNOWN: "unknown",
    cp_model.MODEL_INVALID: "unknown",
}


class ShiftViolatesUnionRulesError(ValueError):
    """A shift *template* itself is malformed against §3.1's union rules -
    caught at model-build time, before any solving happens. Not a CP-SAT
    infeasibility (that means "no valid combination of assignments exists
    for otherwise-valid shifts"); this means one of the input shifts was
    never valid to offer in the first place."""

    def __init__(self, shift_id: uuid.UUID, reason: str) -> None:
        self.shift_id = shift_id
        self.reason = reason
        super().__init__(f"Shift {shift_id} violates union rules: {reason}")


class UnknownLockedAssignmentError(ValueError):
    """A `LockedAssignment` (§2.2 rule 1/ADR-0058) referenced an
    `employee_id`/`shift_id` not present in this same solve's own
    `employees`/`shifts` - a caller bug (whatever builds the merged
    `SolveInput` for a re-optimization must always include the shifts/
    employees its own locked assignments reference), not a modeling
    question."""

    def __init__(self, employee_id: uuid.UUID, shift_id: uuid.UUID) -> None:
        self.employee_id = employee_id
        self.shift_id = shift_id
        super().__init__(
            f"Locked assignment references unknown employee {employee_id} or shift {shift_id}."
        )


def solve(solve_input: SolveInput) -> SolveResult:
    relaxed = solve_input.relaxed_categories
    _validate_shifts(solve_input.shifts, solve_input.policy, relaxed)
    _validate_locked_assignments(solve_input)
    locked_pairs = frozenset(
        (locked.employee_id, locked.shift_id) for locked in solve_input.locked_assignments
    )
    all_days = _date_range(solve_input.date_range_start, solve_input.date_range_end)

    model = cp_model.CpModel()
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar] = {}
    for shift in solve_input.shifts:
        for employee in solve_input.employees:
            pair = (employee.id, shift.id)
            # ADR-0058: a locked pair gets a variable unconditionally,
            # bypassing `_is_eligible` - the human decision already
            # happened, the solver works around it rather than
            # re-litigating it.
            if pair in locked_pairs or _is_eligible(employee, shift, solve_input.leave_records):
                x[pair] = model.new_bool_var(f"x_{employee.id}_{shift.id}")
    for pair in locked_pairs:
        model.add(x[pair] == 1)

    _add_coverage_constraints(model, x, solve_input.employees, solve_input.shifts)
    _add_no_conflict_constraints(
        model, x, solve_input.employees, solve_input.shifts, solve_input.policy, relaxed, locked_pairs
    )
    if RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS not in relaxed:
        for employee in solve_input.employees:
            _add_max_consecutive_days_constraints(
                model,
                x,
                employee,
                solve_input.shifts,
                all_days,
                solve_input.policy.max_consecutive_working_days,
                locked_pairs,
            )
    cap_minutes_by_employee = _add_contracted_hours_constraints(
        model, x, solve_input.employees, solve_input.shifts, relaxed, locked_pairs
    )

    if solve_input.fairness is not None:
        _add_fairness_constraint(
            model,
            x,
            solve_input.employees,
            solve_input.shifts,
            solve_input.fairness,
            solve_input.fairness_history_counts,
        )

    objective_terms = _build_objective_terms(
        model, x, solve_input.employees, solve_input.shifts, solve_input.soft_weights, cap_minutes_by_employee
    )
    if objective_terms:
        model.maximize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = solve_input.time_limit_seconds
    started = time.perf_counter()
    status = solver.solve(model)
    duration_ms = int((time.perf_counter() - started) * 1000)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SolveResult(status=_STATUS_NAMES[status], assignments=(), solve_duration_ms=duration_ms)

    shift_by_id = {s.id: s for s in solve_input.shifts}
    assigned_pairs = [pair for pair, var in x.items() if solver.value(var)]
    assigned_minutes_by_employee_week: dict[tuple[uuid.UUID, date], float] = defaultdict(float)
    for employee_id, shift_id in assigned_pairs:
        week = _week_start(shift_by_id[shift_id].start.date())
        assigned_minutes_by_employee_week[(employee_id, week)] += shift_by_id[shift_id].duration_hours * 60

    assignments = tuple(
        Assignment(
            employee_id=employee_id,
            shift_id=shift_id,
            # Only meaningful for overtime-approved employees - everyone
            # else is hard-capped at their weekly contract hours by
            # `_add_contracted_hours_constraints`, so this can never be True
            # for them. §3.1's flag is about *permission* to exceed contract
            # hours, not about which specific shift "is" the overtime one -
            # that finer-grained attribution is out of this phase's scope.
            # Compared per calendar week, matching how the cap itself is
            # enforced - see `_add_contracted_hours_constraints`.
            is_overtime=(
                assigned_minutes_by_employee_week[
                    (employee_id, _week_start(shift_by_id[shift_id].start.date()))
                ]
                > cap_minutes_by_employee.get(employee_id, float("inf")) + 1e-6
            ),
        )
        for employee_id, shift_id in assigned_pairs
    )
    objective_value = solver.objective_value if objective_terms else None
    return SolveResult(
        status=_STATUS_NAMES[status],
        assignments=assignments,
        solve_duration_ms=duration_ms,
        objective_value=objective_value,
    )


def _validate_shifts(
    shifts: Sequence[ShiftSlot], policy: EmploymentPolicy, relaxed: frozenset[str] = frozenset()
) -> None:
    """Union-rule shift-template validation (§3.1). Deliberately not a
    CP-SAT constraint: *where* within a shift a break falls is floor-level
    scheduling this module doesn't do - what this module can and must
    enforce is that a shift offered to the solver already carries a
    long-enough break when the policy requires one, and that its overall
    length falls inside the policy's bounds. A shift that fails this is
    rejected outright, before any employee could ever be considered for it.

    `RELAXATION_SHIFT_LENGTH_BOUNDS` (ADR-0057) skips only the min/max
    length checks - the mandatory-break check is never relaxed, at any
    human's approval, since it's tied directly to fatigue/safety rather
    than a negotiable contractual bound."""
    length_bounds_relaxed = RELAXATION_SHIFT_LENGTH_BOUNDS in relaxed
    for shift in shifts:
        duration_minutes = shift.duration_hours * 60
        if not length_bounds_relaxed:
            if duration_minutes < policy.min_shift_length_minutes:
                raise ShiftViolatesUnionRulesError(
                    shift.id,
                    f"duration {duration_minutes:.0f}min is below the minimum shift "
                    f"length of {policy.min_shift_length_minutes}min",
                )
            if (
                policy.max_shift_length_minutes is not None
                and duration_minutes > policy.max_shift_length_minutes
            ):
                raise ShiftViolatesUnionRulesError(
                    shift.id,
                    f"duration {duration_minutes:.0f}min exceeds the maximum shift "
                    f"length of {policy.max_shift_length_minutes}min",
                )
        if (
            policy.mandatory_break_after_hours is not None
            and shift.duration_hours > policy.mandatory_break_after_hours
            and shift.break_minutes < (policy.mandatory_break_minutes or 0)
        ):
            raise ShiftViolatesUnionRulesError(
                shift.id,
                f"duration {shift.duration_hours:.1f}h exceeds the "
                f"{policy.mandatory_break_after_hours}h mandatory-break threshold but "
                f"only carries a {shift.break_minutes}min break "
                f"(needs >= {policy.mandatory_break_minutes}min)",
            )


def _is_eligible(employee: Employee, shift: ShiftSlot, leave_records: Sequence[LeaveRecord]) -> bool:
    if not employee.has_skill(shift.required_skill_id, shift.start.date()):
        return False
    return not any(
        record.employee_id == employee.id and record.blocks(shift.start) for record in leave_records
    )


def _validate_locked_assignments(solve_input: SolveInput) -> None:
    employee_ids = {e.id for e in solve_input.employees}
    shift_ids = {s.id for s in solve_input.shifts}
    for locked in solve_input.locked_assignments:
        if locked.employee_id not in employee_ids or locked.shift_id not in shift_ids:
            raise UnknownLockedAssignmentError(locked.employee_id, locked.shift_id)


def _add_coverage_constraints(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
) -> None:
    """Not literally named in §3.1's table, but the structural precondition
    that makes the rest of the model meaningful: without a coverage floor,
    "assign no one to anything" trivially satisfies every other hard
    constraint. `>=`, not `==` - overstaffing beyond the requirement isn't a
    labor-law/contract violation, so it isn't rejected here; Phase 3's
    cost-minimization objective is what discourages it once an objective
    function exists at all."""
    for shift in shifts:
        vars_for_shift = [x[(e.id, shift.id)] for e in employees if (e.id, shift.id) in x]
        model.add(sum(vars_for_shift) >= shift.required_headcount)


def _add_no_conflict_constraints(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
    policy: EmploymentPolicy,
    relaxed: frozenset[str] = frozenset(),
    locked_pairs: frozenset[tuple[uuid.UUID, uuid.UUID]] = frozenset(),
) -> None:
    """One check covers two things at once: two shifts that overlap in time
    can never both be assigned to the same employee (prevents
    `ScheduleConflict.double_booking` by construction, not by post-hoc
    detection), and two non-overlapping shifts with too little gap between
    them violate §3.1's minimum-rest labor-law constraint. Both reduce to
    "the gap between them (negative if overlapping) is less than the
    required rest," so one pairwise constraint expresses both.

    `RELAXATION_MIN_REST_BETWEEN_SHIFTS` (ADR-0057) only ever lowers the
    effective rest requirement to 0 - it can never relax overlap prevention
    itself (a `min_rest_hours` of 0 still catches a negative gap, i.e. two
    shifts that literally overlap), since double-booking is a physical
    impossibility, not a policy choice, and is never a relaxation candidate.

    ADR-0058: skipped entirely when *both* shifts in a pair are locked for
    the same employee - two already-fixed assignments that conflict with
    each other are an existing fact (visible as `ScheduleConflict.
    double_booking`, not something this constraint can "prevent" without
    making the whole model infeasible over a decision that was never the
    solver's to make). A locked-vs-solvable pair still gets the constraint
    normally - the solver just won't pick the solvable side if it would
    conflict with the fixed one, which never causes infeasibility on its
    own."""
    min_rest_hours = (
        0.0 if RELAXATION_MIN_REST_BETWEEN_SHIFTS in relaxed else policy.min_rest_hours_between_shifts
    )
    for employee in employees:
        candidate_shifts = [s for s in shifts if (employee.id, s.id) in x]
        for i, shift_a in enumerate(candidate_shifts):
            for shift_b in candidate_shifts[i + 1 :]:
                both_locked = (employee.id, shift_a.id) in locked_pairs and (
                    employee.id,
                    shift_b.id,
                ) in locked_pairs
                if both_locked:
                    continue
                if _conflicts(shift_a, shift_b, min_rest_hours):
                    model.add(x[(employee.id, shift_a.id)] + x[(employee.id, shift_b.id)] <= 1)


def _conflicts(shift_a: ShiftSlot, shift_b: ShiftSlot, min_rest_hours: float) -> bool:
    earlier, later = (shift_a, shift_b) if shift_a.start <= shift_b.start else (shift_b, shift_a)
    if later.start < earlier.end:
        return True  # time overlap
    gap_hours = (later.start - earlier.end).total_seconds() / 3600.0
    return gap_hours < min_rest_hours


def _add_max_consecutive_days_constraints(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employee: Employee,
    shifts: Sequence[ShiftSlot],
    all_days: Sequence[date],
    max_consecutive_days: int,
    locked_pairs: frozenset[tuple[uuid.UUID, uuid.UUID]] = frozenset(),
) -> None:
    """ADR-0058: each rolling window's bound is `max(max_consecutive_days,
    locked_days_in_window)` - a locked streak that already meets or exceeds
    the policy max caps *additional* solvable days at zero for that window
    rather than making the model infeasible over a decision that was
    already made."""
    shifts_by_day: dict[date, list[ShiftSlot]] = defaultdict(list)
    locked_days: set[date] = set()
    for shift in shifts:
        if (employee.id, shift.id) in x:
            shifts_by_day[shift.start.date()].append(shift)
        if (employee.id, shift.id) in locked_pairs:
            locked_days.add(shift.start.date())

    worked: dict[date, cp_model.IntVar] = {}
    for day in all_days:
        day_vars = [x[(employee.id, s.id)] for s in shifts_by_day.get(day, [])]
        worked_var = model.new_bool_var(f"worked_{employee.id}_{day.isoformat()}")
        if day_vars:
            # worked=1 whenever any shift that day is assigned, and cannot
            # be 1 when none are - both directions needed so the window sum
            # below reflects real work, not a var CP-SAT is free to leave
            # slack on.
            for var in day_vars:
                model.add(worked_var >= var)
            model.add(worked_var <= sum(day_vars))
        else:
            model.add(worked_var == 0)
        worked[day] = worked_var

    window_size = max_consecutive_days + 1
    if window_size > len(all_days):
        return  # the schedule's own date range is too short for this to ever bind
    for start_idx in range(len(all_days) - window_size + 1):
        window = all_days[start_idx : start_idx + window_size]
        locked_count_in_window = sum(1 for d in window if d in locked_days)
        effective_max = max(max_consecutive_days, locked_count_in_window)
        model.add(sum(worked[d] for d in window) <= effective_max)


def _add_contracted_hours_constraints(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
    relaxed: frozenset[str] = frozenset(),
    locked_pairs: frozenset[tuple[uuid.UUID, uuid.UUID]] = frozenset(),
) -> dict[uuid.UUID, float]:
    """§3.1: exceeding contract hours without `overtime_approved` is
    disallowed *at the constraint level* - a hard cap, not a discouraged
    outcome. The cap applies per calendar (Monday-start) week, not prorated
    by the solve's overall date-range span - `contract_hours_per_week` is a
    per-week figure, and a single ordinary shift within one week must never
    read as "exceeding a 40h/week contract" just because the scope being
    solved happens to cover only one day of it. Employees with
    `overtime_approved` get no upper bound here at all (module prompt
    doesn't name a separate absolute legal-max-hours constraint; if a future
    phase needs one, it composes the same way this one does).

    `RELAXATION_CONTRACTED_HOURS` (ADR-0057) drops the cap for every
    employee, not just non-approved ones - `cap_minutes_by_employee` is
    still computed and returned unconditionally either way, since it's also
    used for `is_overtime` attribution and the overtime-cost objective term,
    which stay meaningful (informational, not enforced) even when relaxed.

    ADR-0058: each week's effective cap is `max(cap_minutes,
    locked_minutes_that_week)` - a locked assignment (e.g. a manual
    override) that alone already exceeds the contract cap caps *additional*
    solvable minutes that week at zero rather than making the model
    infeasible."""
    relax_all = RELAXATION_CONTRACTED_HOURS in relaxed
    cap_minutes_by_employee: dict[uuid.UUID, float] = {}
    for employee in employees:
        cap_minutes = employee.contract_hours_per_week * 60
        cap_minutes_by_employee[employee.id] = cap_minutes
        if employee.overtime_approved or relax_all:
            continue
        shifts_by_week: dict[date, list[ShiftSlot]] = defaultdict(list)
        locked_minutes_by_week: dict[date, int] = defaultdict(int)
        for shift in shifts:
            if (employee.id, shift.id) in x:
                shifts_by_week[_week_start(shift.start.date())].append(shift)
            if (employee.id, shift.id) in locked_pairs:
                locked_minutes_by_week[_week_start(shift.start.date())] += round(shift.duration_hours * 60)
        for week_start, week_shifts in shifts_by_week.items():
            minute_terms = [x[(employee.id, s.id)] * round(s.duration_hours * 60) for s in week_shifts]
            effective_cap = max(round(cap_minutes), locked_minutes_by_week.get(week_start, 0))
            model.add(sum(minute_terms) <= effective_cap)
    return cap_minutes_by_employee


def _week_start(day: date) -> date:
    """Monday of the ISO week containing `day` - the bucketing key for
    per-week contract-hours enforcement."""
    return day - timedelta(days=day.weekday())


def _date_range(start: date, end: date) -> list[date]:
    days = (end - start).days
    return [start + timedelta(days=offset) for offset in range(days + 1)]


def _add_fairness_constraint(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
    fairness: FairnessConfig,
    fairness_history_counts: Mapping[uuid.UUID, int],
) -> None:
    """§3.3: bounds each roster employee's undesirable-shift count - prior
    *published* history (`fairness_history_counts`, the `FairnessLedger`
    query result) plus this solve's own assignments - to within `tolerance`
    of the roster's own average. A real CP-SAT constraint the solver cannot
    trade away, not a weighted objective term (the module prompt is explicit
    that fairness gets this treatment, unlike §3.2's other soft terms).

    `count[e] * n` vs. the group's summed total (`n` = roster size) is
    algebraically `|count[e] - average| <= tolerance` without needing
    division, which CP-SAT's integer linear constraints don't support
    directly."""
    n = len(employees)
    if n == 0:
        return
    undesirable_shift_ids = {s.id for s in shifts if fairness.is_undesirable(s.start)}
    if not undesirable_shift_ids:
        return  # nothing in this job's own scope could ever move anyone's count

    total_counts = {}
    for employee in employees:
        assigned_terms = [
            x[(employee.id, shift_id)] for shift_id in undesirable_shift_ids if (employee.id, shift_id) in x
        ]
        total_counts[employee.id] = fairness_history_counts.get(employee.id, 0) + sum(assigned_terms)

    total_expr = sum(total_counts.values())
    tolerance_n = fairness.tolerance * n
    for employee in employees:
        count_expr = total_counts[employee.id]
        model.add(count_expr * n - total_expr <= tolerance_n)
        model.add(total_expr - count_expr * n <= tolerance_n)


def _build_objective_terms(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
    soft_weights: SoftWeights,
    cap_minutes_by_employee: dict[uuid.UUID, float],
) -> list[Any]:
    """§3.2's weighted, tradeable objective terms, combined into a single
    `model.maximize(...)` call by `solve()`. Each term is independently
    switched off by a zero weight (a tenant can opt out of any one of them
    via `constraint_config` without touching the others)."""
    terms: list[Any] = []

    if soft_weights.preference_weight:
        preference_vars = [
            x[(employee.id, shift.id)]
            for employee in employees
            for shift in shifts
            if shift.id in employee.preferred_shift_ids and (employee.id, shift.id) in x
        ]
        if preference_vars:
            terms.append(soft_weights.preference_weight * sum(preference_vars))

    if soft_weights.overtime_cost_weight:
        # "Cost minimization" (§3.2) covers both named costs: overtime
        # minutes, and unnecessary labor from assigning more people than a
        # shift's `required_headcount` (coverage is `>=`, not `==` -
        # ADR/`_add_coverage_constraints` - so nothing else in the model
        # penalizes an otherwise-harmless extra assignment; without this,
        # CP-SAT is free to pad shifts with redundant staff at zero cost).
        # Sharing one weight for both is a deliberate simplification: a
        # tenant that cares about cost minimization cares about both, and
        # overtime's per-*minute* cost naturally dominates a headcount
        # excess's per-*assignment* cost in this shared scale, which matches
        # real-world relative severity closely enough for this phase.
        overtime_vars = _add_overtime_penalty_vars(model, x, employees, shifts, cap_minutes_by_employee)
        excess_terms = _coverage_excess_terms(x, employees, shifts)
        penalty_terms = [*overtime_vars, *excess_terms]
        if penalty_terms:
            terms.append(-soft_weights.overtime_cost_weight * sum(penalty_terms))

    if soft_weights.skill_decay_weight:
        # Scaled by 1000 to keep the coefficient integral (decay_score is a
        # 0.0-1.0 float) - same "round to an integer unit before handing it
        # to CP-SAT" convention as duration-in-minutes elsewhere in this file.
        decay_terms = [
            x[(employee.id, shift.id)] * round(employee.decay_score_for(shift.required_skill_id) * 1000)
            for employee in employees
            for shift in shifts
            if shift.required_skill_id is not None and (employee.id, shift.id) in x
        ]
        if decay_terms:
            terms.append(-soft_weights.skill_decay_weight * sum(decay_terms))

    if soft_weights.cross_skill_balance_weight:
        used_vars = _cross_skill_balance_vars(model, x, employees, shifts)
        if used_vars:
            terms.append(soft_weights.cross_skill_balance_weight * sum(used_vars))

    return terms


def _add_overtime_penalty_vars(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
    cap_minutes_by_employee: dict[uuid.UUID, float],
) -> list[cp_model.IntVar]:
    """One `overtime_minutes[employee, week] >= 0` slack variable per
    (overtime-approved employee, week with candidate shifts), linked to
    `>= assigned_minutes_that_week - cap`. Non-approved employees are
    already hard-capped by `_add_contracted_hours_constraints` and can never
    have overtime, so no variable (and no objective penalty) is needed for
    them at all."""
    overtime_vars: list[cp_model.IntVar] = []
    for employee in employees:
        if not employee.overtime_approved:
            continue
        cap_minutes = round(cap_minutes_by_employee.get(employee.id, 0.0))
        shifts_by_week: dict[date, list[ShiftSlot]] = defaultdict(list)
        for shift in shifts:
            if (employee.id, shift.id) in x:
                shifts_by_week[_week_start(shift.start.date())].append(shift)
        for week, week_shifts in shifts_by_week.items():
            assigned_minutes_expr = sum(
                x[(employee.id, s.id)] * round(s.duration_hours * 60) for s in week_shifts
            )
            max_possible_minutes = sum(round(s.duration_hours * 60) for s in week_shifts)
            upper_bound = max(max_possible_minutes - cap_minutes, 0)
            overtime_var = model.new_int_var(0, upper_bound, f"overtime_{employee.id}_{week.isoformat()}")
            model.add(overtime_var >= assigned_minutes_expr - cap_minutes)
            overtime_vars.append(overtime_var)
    return overtime_vars


def _coverage_excess_terms(
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
) -> list[Any]:
    """`sum(assigned) - required_headcount` per shift - always `>= 0` since
    `_add_coverage_constraints` already enforces the floor, so this is a
    plain linear expression (no new variable/constraint needed) usable
    directly as an objective penalty term."""
    terms: list[Any] = []
    for shift in shifts:
        vars_for_shift = [
            x[(employee.id, shift.id)] for employee in employees if (employee.id, shift.id) in x
        ]
        if vars_for_shift:
            terms.append(sum(vars_for_shift) - shift.required_headcount)
    return terms


def _cross_skill_balance_vars(
    model: cp_model.CpModel,
    x: dict[tuple[uuid.UUID, uuid.UUID], cp_model.IntVar],
    employees: Sequence[Employee],
    shifts: Sequence[ShiftSlot],
) -> list[cp_model.IntVar]:
    """§3.2: "avoid over-concentrating rare skills on too few shifts." One
    `skill_used[employee, skill] = OR(x[employee, s] for s requiring skill)`
    reified boolean per (employee, required skill) pair with at least one
    candidate shift - rewarding the objective for each *distinct* employee
    who ends up touching a given skill discourages concentrating that
    skill's coverage on just one or two people, without prescribing an exact
    distribution (which would need to be a hard constraint, and the module
    prompt only lists this as a soft/objective term)."""
    used_vars: list[cp_model.IntVar] = []
    skill_ids = {s.required_skill_id for s in shifts if s.required_skill_id is not None}
    for skill_id in skill_ids:
        skill_shifts = [s for s in shifts if s.required_skill_id == skill_id]
        for employee in employees:
            candidate_vars = [x[(employee.id, s.id)] for s in skill_shifts if (employee.id, s.id) in x]
            if not candidate_vars:
                continue
            used_var = model.new_bool_var(f"skill_used_{employee.id}_{skill_id}")
            for var in candidate_vars:
                model.add(used_var >= var)
            model.add(used_var <= sum(candidate_vars))
            used_vars.append(used_var)
    return used_vars
