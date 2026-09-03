"""Module 07 (Shift Marketplace)'s single-assignment eligibility check
(docs/adr/0082) - "would assigning `candidate` to `candidate_shift` violate a
hard constraint?", evaluated against the candidate's other already-persisted
assignments, without running a CP-SAT solve.

Reuse posture, function by function:
- `_is_eligible`/`_conflicts` (`app/solver/model.py`) are imported and called
  verbatim - both were already pure, CP-SAT-model-free functions (confirmed
  by `model.py`'s own docstring and its `tests/unit/test_solver_constraints.py`
  suite exercising them with no CP-SAT model at all), so there is nothing to
  re-express for them.
- Max-consecutive-days and contracted-hours have no such standalone form in
  `model.py` - `_add_max_consecutive_days_constraints`/
  `_add_contracted_hours_constraints` express the *same* window/cap
  arithmetic this module needs, but only as `model.add(sum(vars) <= cap)`
  CP-SAT constraints over decision variables, which cannot be evaluated
  without a model+solver. `_would_exceed_max_consecutive_days`/
  `_would_exceed_contracted_hours` below are a faithful, narrow
  re-expression of that same arithmetic (same window size
  `max_consecutive_days + 1`, same per-ISO-week minute bucketing) against
  concrete dates/assignments instead of decision variables - not an
  independent design. `tests/unit/test_eligibility_matches_solver.py` is the
  drift guard: it runs the same synthetic fixture through both `solve()` and
  this module's checks and asserts they agree, so a future change to either
  side's arithmetic that silently diverges from the other fails CI rather
  than shipping quietly.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from app.solver.model import _conflicts, _is_eligible
from app.solver.types import Employee, EmploymentPolicy, LeaveRecord, ShiftSlot

CATEGORY_SKILL = "skill"
CATEGORY_LEAVE_CONFLICT = "leave_conflict"
CATEGORY_SHIFT_OVERLAP = "shift_overlap"
CATEGORY_MIN_REST = "min_rest"
CATEGORY_MAX_CONSECUTIVE_DAYS = "max_consecutive_days"
CATEGORY_CONTRACTED_HOURS = "contracted_hours"


@dataclass(frozen=True)
class EligibilityViolation:
    category: str
    detail: str


def evaluate_assignment_eligibility(
    *,
    candidate: Employee,
    candidate_shift: ShiftSlot,
    existing_shifts: Sequence[ShiftSlot],
    leave_records: Sequence[LeaveRecord],
    policy: EmploymentPolicy,
) -> tuple[EligibilityViolation, ...]:
    """`existing_shifts` must already exclude the assignment being given up
    in a swap (the caller's job - see the .proto's `exclude_shift_assignment_id`)
    and should span a wide enough window to make the consecutive-days and
    contracted-hours checks below meaningful (the gRPC servicer queries a
    +/-14-day window around `candidate_shift`, comfortably wider than any
    realistic `max_consecutive_working_days` or single ISO week)."""
    violations: list[EligibilityViolation] = []

    if not candidate.has_skill(candidate_shift.required_skill_id, candidate_shift.start.date()):
        violations.append(
            EligibilityViolation(
                CATEGORY_SKILL,
                f"employee lacks required skill {candidate_shift.required_skill_id} "
                f"as of {candidate_shift.start.date().isoformat()}",
            )
        )
    if not _is_eligible(candidate, candidate_shift, leave_records):
        # `_is_eligible` failed but the skill check above passed - the only
        # other thing it checks is leave/unavailability (model.py:252-257).
        if not any(v.category == CATEGORY_SKILL for v in violations):
            violations.append(
                EligibilityViolation(
                    CATEGORY_LEAVE_CONFLICT,
                    f"employee has approved leave covering "
                    f"{candidate_shift.start.date().isoformat()}",
                )
            )

    min_rest_hours = policy.min_rest_hours_between_shifts
    for other in existing_shifts:
        if _conflicts(candidate_shift, other, min_rest_hours):
            overlap = other.start < candidate_shift.end and candidate_shift.start < other.end
            category = CATEGORY_SHIFT_OVERLAP if overlap else CATEGORY_MIN_REST
            violations.append(
                EligibilityViolation(
                    category,
                    f"conflicts with existing assignment "
                    f"{other.start.isoformat()}-{other.end.isoformat()}"
                    + ("" if overlap else f" (< {min_rest_hours}h rest)"),
                )
            )

    consecutive_violation = _would_exceed_max_consecutive_days(
        candidate_shift, existing_shifts, policy.max_consecutive_working_days
    )
    if consecutive_violation is not None:
        violations.append(consecutive_violation)

    if not candidate.overtime_approved:
        hours_violation = _would_exceed_contracted_hours(
            candidate, candidate_shift, existing_shifts
        )
        if hours_violation is not None:
            violations.append(hours_violation)

    return tuple(violations)


def _would_exceed_max_consecutive_days(
    candidate_shift: ShiftSlot,
    existing_shifts: Sequence[ShiftSlot],
    max_consecutive_days: int,
) -> EligibilityViolation | None:
    """Same window (`max_consecutive_days + 1` days) and same "count worked
    days in the window, reject if it exceeds the cap" rule as
    `_add_max_consecutive_days_constraints` (`app/solver/model.py:343-388`),
    evaluated against concrete worked days instead of CP-SAT bool vars."""
    worked_days = {s.start.date() for s in existing_shifts} | {candidate_shift.start.date()}
    candidate_day = candidate_shift.start.date()
    window_size = max_consecutive_days + 1

    for offset in range(window_size):
        window_start = candidate_day - timedelta(days=window_size - 1 - offset)
        window = [window_start + timedelta(days=d) for d in range(window_size)]
        worked_in_window = sum(1 for d in window if d in worked_days)
        if worked_in_window > max_consecutive_days:
            return EligibilityViolation(
                CATEGORY_MAX_CONSECUTIVE_DAYS,
                f"would work {worked_in_window} consecutive days in the window "
                f"{window[0].isoformat()}..{window[-1].isoformat()} "
                f"(max {max_consecutive_days})",
            )
    return None


def _would_exceed_contracted_hours(
    candidate: Employee,
    candidate_shift: ShiftSlot,
    existing_shifts: Sequence[ShiftSlot],
) -> EligibilityViolation | None:
    """Same per-ISO-week (Monday-start) minute-sum cap as
    `_add_contracted_hours_constraints` (`app/solver/model.py:391-439`),
    evaluated against concrete assignments instead of CP-SAT decision
    variables. Only called when `not candidate.overtime_approved` - an
    overtime-approved employee has no upper bound here, matching the
    solver's own posture exactly."""
    week_start = _week_start(candidate_shift.start.date())
    week_end = week_start + timedelta(days=6)
    same_week_minutes = sum(
        round(s.duration_hours * 60)
        for s in existing_shifts
        if week_start <= s.start.date() <= week_end
    )
    total_minutes = same_week_minutes + round(candidate_shift.duration_hours * 60)
    cap_minutes = round(candidate.contract_hours_per_week * 60)
    if total_minutes > cap_minutes:
        return EligibilityViolation(
            CATEGORY_CONTRACTED_HOURS,
            f"would total {total_minutes}min in the week of {week_start.isoformat()} "
            f"(contract cap {cap_minutes}min)",
        )
    return None


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


# Re-exported so callers (the gRPC servicer, tests) never need to import
# from app.solver.model directly for these two - keeps the "which functions
# are reused verbatim" list visible in one place, per this module's own
# docstring.
__all__ = [
    "CATEGORY_CONTRACTED_HOURS",
    "CATEGORY_LEAVE_CONFLICT",
    "CATEGORY_MAX_CONSECUTIVE_DAYS",
    "CATEGORY_MIN_REST",
    "CATEGORY_SHIFT_OVERLAP",
    "CATEGORY_SKILL",
    "EligibilityViolation",
    "evaluate_assignment_eligibility",
]
