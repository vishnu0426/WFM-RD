"""§5's infeasibility-handling relaxation search (Phase 4), ADR-0057's
ordering and non-relaxable set. Only ever invoked after a baseline `solve()`
call has already returned `status: infeasible` - never runs speculatively,
and never runs at all for `optimal`/`feasible`/`unknown` outcomes.

`search_relaxations` never persists or "applies" anything - it only
*discovers* whether a feasible schedule exists under some relaxed subset of
§3.1's hard constraints and reports exactly what that would cost. §5 point
4's non-negotiable ("the system never auto-applies a relaxation... without a
human approving it") is enforced by every caller of this module, not by this
module itself - `job_service.create_job` records the result in
`ScheduleJob.relaxations_applied` and leaves `status: infeasible`;
`job_service.approve_relaxation` is the only code path that ever turns a
`RelaxationSearchResult` into a real `Schedule`.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from app.solver.model import ShiftViolatesUnionRulesError, solve
from app.solver.types import (
    RELAXATION_CONTRACTED_HOURS,
    RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS,
    RELAXATION_MIN_REST_BETWEEN_SHIFTS,
    RELAXATION_ORDER,
    RELAXATION_SHIFT_LENGTH_BOUNDS,
    RelaxationSearchResult,
    ShiftSlot,
    SolveInput,
    SolveResult,
)

_CATEGORY_LABELS = {
    RELAXATION_CONTRACTED_HOURS: "the contracted-hours cap",
    RELAXATION_SHIFT_LENGTH_BOUNDS: "the shift length bounds",
    RELAXATION_MIN_REST_BETWEEN_SHIFTS: "the minimum rest between shifts",
    RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS: "the maximum consecutive working days",
}


def search_relaxations(solve_input: SolveInput) -> RelaxationSearchResult:
    """Cumulative, cost-ascending search (ADR-0057): try relaxing category 1
    alone; if still infeasible, try 1+2; then 1+2+3; then all four. Stops at
    the first combination that solves. `solve_input` is expected to carry no
    relaxations of its own (a plain baseline `SolveInput`) - this function
    builds its own progressively-relaxed copies via `dataclasses.replace`."""
    applied: list[str] = []
    for category in RELAXATION_ORDER:
        applied.append(category)
        candidate = dataclasses.replace(solve_input, relaxed_categories=frozenset(applied))
        try:
            result = solve(candidate)
        except ShiftViolatesUnionRulesError:
            # Only reachable in principle if a caller ever passes a
            # `solve_input` whose shifts weren't already validated - see
            # ADR-0057's "structural gap" note: in this module's actual job-
            # submission flow, such a job never reaches `infeasible` (or
            # this search) in the first place, since `_validate_shifts`
            # rejects it outright at submission time.
            continue
        if result.status in ("optimal", "feasible"):
            cost_summary = _compute_cost_summary(solve_input, applied, result)
            explanation = _build_explanation(applied, cost_summary, feasible=True)
            return RelaxationSearchResult(
                attempted_categories=tuple(applied),
                feasible=True,
                result=result,
                cost_summary=cost_summary,
                explanation=explanation,
            )
    return RelaxationSearchResult(
        attempted_categories=tuple(applied),
        feasible=False,
        result=None,
        cost_summary={},
        explanation=_build_explanation(applied, {}, feasible=False),
    )


def _compute_cost_summary(original: SolveInput, applied: list[str], result: SolveResult) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if RELAXATION_CONTRACTED_HOURS in applied:
        summary[RELAXATION_CONTRACTED_HOURS] = _contracted_hours_cost(original, result)
    if RELAXATION_SHIFT_LENGTH_BOUNDS in applied:
        summary[RELAXATION_SHIFT_LENGTH_BOUNDS] = _shift_length_bounds_cost(original)
    if RELAXATION_MIN_REST_BETWEEN_SHIFTS in applied:
        summary[RELAXATION_MIN_REST_BETWEEN_SHIFTS] = _min_rest_cost(original, result)
    if RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS in applied:
        summary[RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS] = _max_consecutive_days_cost(original, result)
    return summary


def _contracted_hours_cost(original: SolveInput, result: SolveResult) -> dict[str, Any]:
    shift_by_id = {s.id: s for s in original.shifts}
    employee_by_id = {e.id: e for e in original.employees}
    assigned_minutes: dict[tuple[uuid.UUID, date], float] = defaultdict(float)
    for assignment in result.assignments:
        shift = shift_by_id[assignment.shift_id]
        assigned_minutes[(assignment.employee_id, _week_start(shift.start.date()))] += (
            shift.duration_hours * 60
        )

    details: list[dict[str, Any]] = []
    for (employee_id, week), minutes in assigned_minutes.items():
        employee = employee_by_id[employee_id]
        if employee.overtime_approved:
            continue
        cap_minutes = employee.contract_hours_per_week * 60
        if minutes > cap_minutes:
            details.append(
                {
                    "employeeId": str(employee_id),
                    "week": week.isoformat(),
                    "additionalMinutes": round(minutes - cap_minutes),
                }
            )
    return {
        "employeesAffected": sorted({d["employeeId"] for d in details}),
        "totalAdditionalOvertimeMinutes": sum(d["additionalMinutes"] for d in details),
        "details": details,
    }


def _shift_length_bounds_cost(original: SolveInput) -> dict[str, Any]:
    policy = original.policy
    details: list[dict[str, Any]] = []
    for shift in original.shifts:
        duration_minutes = shift.duration_hours * 60
        if duration_minutes < policy.min_shift_length_minutes:
            details.append(
                {
                    "shiftId": str(shift.id),
                    "durationMinutes": round(duration_minutes),
                    "violatedBound": "min",
                    "limitMinutes": policy.min_shift_length_minutes,
                }
            )
        elif (
            policy.max_shift_length_minutes is not None and duration_minutes > policy.max_shift_length_minutes
        ):
            details.append(
                {
                    "shiftId": str(shift.id),
                    "durationMinutes": round(duration_minutes),
                    "violatedBound": "max",
                    "limitMinutes": policy.max_shift_length_minutes,
                }
            )
    return {"shiftsAffected": sorted({d["shiftId"] for d in details}), "details": details}


def _min_rest_cost(original: SolveInput, result: SolveResult) -> dict[str, Any]:
    shift_by_id = {s.id: s for s in original.shifts}
    shifts_by_employee: dict[uuid.UUID, list[ShiftSlot]] = defaultdict(list)
    for assignment in result.assignments:
        shifts_by_employee[assignment.employee_id].append(shift_by_id[assignment.shift_id])

    required_hours = original.policy.min_rest_hours_between_shifts
    details: list[dict[str, Any]] = []
    for employee_id, shifts in shifts_by_employee.items():
        ordered = sorted(shifts, key=lambda s: s.start)
        for earlier, later in zip(ordered, ordered[1:], strict=False):
            if later.start < earlier.end:
                continue  # overlap - never relaxed, so never reachable here
            gap_hours = (later.start - earlier.end).total_seconds() / 3600.0
            if gap_hours < required_hours:
                details.append(
                    {
                        "employeeId": str(employee_id),
                        "shiftIdA": str(earlier.id),
                        "shiftIdB": str(later.id),
                        "actualRestHours": round(gap_hours, 2),
                        "requiredRestHours": required_hours,
                    }
                )
    return {"employeesAffected": sorted({d["employeeId"] for d in details}), "details": details}


def _max_consecutive_days_cost(original: SolveInput, result: SolveResult) -> dict[str, Any]:
    shift_by_id = {s.id: s for s in original.shifts}
    days_by_employee: dict[uuid.UUID, set[date]] = defaultdict(set)
    for assignment in result.assignments:
        days_by_employee[assignment.employee_id].add(shift_by_id[assignment.shift_id].start.date())

    max_allowed = original.policy.max_consecutive_working_days
    details: list[dict[str, Any]] = []
    for employee_id, days in days_by_employee.items():
        streak = _longest_streak(days)
        if streak > max_allowed:
            details.append(
                {
                    "employeeId": str(employee_id),
                    "consecutiveDaysWorked": streak,
                    "allowedMax": max_allowed,
                }
            )
    return {"employeesAffected": sorted({d["employeeId"] for d in details}), "details": details}


def _longest_streak(days: set[date]) -> int:
    longest = 0
    current = 0
    for day in sorted(days):
        current = current + 1 if (day - timedelta(days=1)) in days else 1
        longest = max(longest, current)
    return longest


def _week_start(day: date) -> date:
    """Monday of the ISO week containing `day` - duplicated from
    `app/solver/model.py`'s identically-named helper rather than imported
    (that one is a private, underscore-prefixed implementation detail of
    this file's own module)."""
    return day - timedelta(days=day.weekday())


def _join_labels(categories: list[str]) -> str:
    labels = [_CATEGORY_LABELS[c] for c in categories]
    if len(labels) == 1:
        return labels[0]
    return ", ".join(labels[:-1]) + f", and {labels[-1]}"


def _build_explanation(applied: list[str], cost_summary: dict[str, Any], *, feasible: bool) -> str:
    if not feasible:
        return (
            f"No feasible schedule exists even after relaxing {_join_labels(applied)}. Skill "
            "requirements, leave/unavailability, shift-overlap prevention, and mandatory break "
            "placement are never relaxed automatically."
        )
    sentences = [_category_detail_sentence(category, cost_summary.get(category, {})) for category in applied]
    return f"No feasible schedule exists without relaxing {_join_labels(applied)}. " + " ".join(
        s for s in sentences if s
    )


def _category_detail_sentence(category: str, detail: dict[str, Any]) -> str:
    if category == RELAXATION_CONTRACTED_HOURS:
        minutes = detail.get("totalAdditionalOvertimeMinutes", 0)
        employees = len(detail.get("employeesAffected", []))
        if not employees:
            return ""
        return (
            f"Relaxing the overtime cap requires {minutes / 60:.1f} overtime hours across "
            f"{employees} employee(s)."
        )
    if category == RELAXATION_SHIFT_LENGTH_BOUNDS:
        shifts = len(detail.get("shiftsAffected", []))
        if not shifts:
            return ""
        return f"Relaxing shift length bounds affects {shifts} shift(s)."
    if category == RELAXATION_MIN_REST_BETWEEN_SHIFTS:
        employees = len(detail.get("employeesAffected", []))
        if not employees:
            return ""
        return f"Relaxing minimum rest between shifts affects {employees} employee(s)."
    if category == RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS:
        employees = len(detail.get("employeesAffected", []))
        if not employees:
            return ""
        return f"Relaxing maximum consecutive working days affects {employees} employee(s)."
    return ""
