"""Pure domain types for the §3.1 hard-constraint CP-SAT model - deliberately
independent of `app.db.models`/SQLAlchemy and of how this data eventually
arrives (request body in this phase, gRPC pulls from Phase 6 onward - see
docs/adr/0055). Keeping this module import-free of the DB/HTTP layers is what
lets `tests/unit/test_solver_constraints.py` (§8's constraint-correctness
suite) exercise the model against synthetic fixtures with no Postgres/FastAPI
involved at all.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


@dataclass(frozen=True)
class EmployeeSkill:
    skill_id: uuid.UUID
    # None = certification does not expire.
    expires_at: date | None = None
    # §3.2's skill-decay soft term (Module 02's `EmployeeSkill.decay_score`
    # convention): 0.0 = fully fresh proficiency, higher = more decayed.
    # Only meaningful for skill-critical shifts (§3.2: "prefer fresher
    # proficiency on skill-critical queues") - unused otherwise.
    decay_score: float = 0.0

    def covers(self, as_of: date) -> bool:
        return self.expires_at is None or self.expires_at >= as_of


@dataclass(frozen=True)
class Employee:
    id: uuid.UUID
    contract_hours_per_week: float
    # §3.1: "Exceeding without an explicit overtime-approval flag is
    # disallowed at the constraint level" - this is that flag.
    overtime_approved: bool = False
    skills: tuple[EmployeeSkill, ...] = ()
    # §3.2's employee-shift-preference soft term - ids from `shifts` this
    # employee has indicated they'd prefer, sourced the same way every other
    # Phase 2/3 input is (request body - ADR-0055).
    preferred_shift_ids: frozenset[uuid.UUID] = field(default_factory=frozenset)
    # Phase 7 (ADR-0061): this employee's home site, for
    # `app/solver/decomposition.py`'s per-site partitioning.
    # `SchedulableEmployee.org_unit_id` already carries this over gRPC
    # (Phase 6) - `None` (never decomposed) is every pre-Phase-7 caller's
    # exact prior behavior.
    org_unit_id: uuid.UUID | None = None

    def has_skill(self, skill_id: uuid.UUID | None, as_of: date) -> bool:
        if skill_id is None:
            return True
        return any(s.skill_id == skill_id and s.covers(as_of) for s in self.skills)

    def decay_score_for(self, skill_id: uuid.UUID | None) -> float:
        if skill_id is None:
            return 0.0
        return next((s.decay_score for s in self.skills if s.skill_id == skill_id), 0.0)


@dataclass(frozen=True)
class LeaveRecord:
    """§3.1's leave/unavailability constraint - never relaxable (ADR-0057).

    Module 06 Phase 5 (ADR-0078) closed the permanent gap this docstring
    used to describe ("interim data source, Module 06 doesn't exist yet"):
    `solve_input_resolver._resolve_leave_records` now pulls this from
    `LeaveService.GetUnavailability` via gRPC when a solve request omits
    `leaveRecords`, the same optional-field-triggers-pull pattern ADR-0059
    established for `roster`/`policy`. An explicitly request-supplied value
    still wins outright, no merge - unchanged from Phase 2's original
    request-supplied posture (ADR-0055), just no longer the *only* source.
    """

    employee_id: uuid.UUID
    start: date
    end: date  # inclusive

    def blocks(self, shift_start: datetime) -> bool:
        return self.start <= shift_start.date() <= self.end


@dataclass(frozen=True)
class ShiftSlot:
    id: uuid.UUID
    start: datetime
    end: datetime
    required_headcount: int
    required_skill_id: uuid.UUID | None = None
    # Minutes of break already built into this shift template - a property
    # of the shift, not a solver decision. See EmploymentPolicy's mandatory-
    # break fields and `_validate_shifts` in model.py.
    break_minutes: int = 0
    # Phase 7 (ADR-0061): which site this shift belongs to, for
    # `app/solver/decomposition.py`'s per-site partitioning. Request-supplied
    # (there is no gRPC source for a shift's own site) - `None` (never
    # decomposed, every shift treated as one scope) is every pre-Phase-7
    # caller's exact prior behavior.
    org_unit_id: uuid.UUID | None = None

    @property
    def duration_hours(self) -> float:
        return (self.end - self.start).total_seconds() / 3600.0


#: §5/ADR-0057's relaxation categories, cost-ascending. Never includes skill
#: requirement, leave/unavailability, shift-overlap prevention, or mandatory
#: break placement - those are never relaxed by this flow, at any human's
#: approval (ADR-0057).
RELAXATION_CONTRACTED_HOURS = "contracted_hours"
RELAXATION_SHIFT_LENGTH_BOUNDS = "shift_length_bounds"
RELAXATION_MIN_REST_BETWEEN_SHIFTS = "min_rest_between_shifts"
RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS = "max_consecutive_working_days"
RELAXATION_ORDER = (
    RELAXATION_CONTRACTED_HOURS,
    RELAXATION_SHIFT_LENGTH_BOUNDS,
    RELAXATION_MIN_REST_BETWEEN_SHIFTS,
    RELAXATION_MAX_CONSECUTIVE_WORKING_DAYS,
)


@dataclass(frozen=True)
class EmploymentPolicy:
    """§3.1's `EmploymentPolicy`/`union_rule` inputs, flattened to exactly
    what this phase's constraints need. Real fields, not a stand-in - sourced
    from the request body in this phase (ADR-0055), from
    `PolicyService.GetActiveEmploymentPolicy` from Phase 6 onward."""

    max_consecutive_working_days: int
    min_rest_hours_between_shifts: float
    min_shift_length_minutes: int
    max_shift_length_minutes: int | None = None
    mandatory_break_after_hours: float | None = None
    mandatory_break_minutes: int | None = None


@dataclass(frozen=True)
class FairnessConfig:
    """§3.3's bounded, auditable fairness constraint - tenant-configurable,
    never hardcoded (§2.2 rule 3), sourced from `ScheduleJob.constraint_config`
    (`app/api/v1/schemas.py`'s `FairnessConfigInput`). "Undesirable shift" is
    itself tenant-configurable per §3.3 ("weekend, night, holiday - via
    `constraint_config`, not hardcoded"), not a platform-wide fixed
    definition."""

    rolling_period_weeks: int
    tolerance: int
    include_weekends: bool = True
    night_start_hour: int | None = None
    night_end_hour: int | None = None
    holiday_dates: frozenset[date] = field(default_factory=frozenset)

    def is_undesirable(self, shift_start: datetime) -> bool:
        if shift_start.date() in self.holiday_dates:
            return True
        if self.include_weekends and shift_start.weekday() >= 5:
            return True
        if self.night_start_hour is not None and self.night_end_hour is not None:
            hour = shift_start.hour
            if self.night_start_hour <= self.night_end_hour:
                return self.night_start_hour <= hour < self.night_end_hour
            return hour >= self.night_start_hour or hour < self.night_end_hour  # wraps midnight
        return False


@dataclass(frozen=True)
class LockedAssignment:
    """§2.2 rule 1 / ADR-0058: an `(employee, shift)` pair whose assignment
    is already decided - a manual override, a marketplace claim/swap/bid
    acceptance (ADR-0089), or a prior re-optimization's own locked
    assignment carried forward. `solve()` forces this pair's decision
    variable to `1` unconditionally (bypassing `_is_eligible` - a human's
    decision already happened; the solver's job is to work around it, not
    re-litigate it) and treats it as a *given fact* other hard constraints
    accommodate rather than reject - see ADR-0058 for why a locked
    assignment can never make the model infeasible on its own.

    `assignment_source` (§2.1's enum: `manual_override`/`swap`/`bid`/`claim`
    (ADR-0089) - never `auto_generated`, since a `LockedAssignment` only
    exists because something *other* than the solver decided it) carries no
    solver-modeling
    weight at all - `app/solver/model.py` never reads it. It rides along
    purely so `app/services/job_service.py::_persist_schedule` can restore
    the real `assignment_source` on re-persistence (re-optimization,
    relaxation approval) instead of defaulting every assignment to
    `auto_generated` and silently un-marking a prior manual decision as
    machine-made."""

    employee_id: uuid.UUID
    shift_id: uuid.UUID
    assignment_source: str = "manual_override"


@dataclass(frozen=True)
class SoftWeights:
    """§3.2's weighted, tradeable objective terms - all tenant-configurable
    (`ScheduleJob.constraint_config`), all default to a modest positive
    weight rather than 0, so submitting no explicit weights still produces a
    schedule that prefers matching preferences/fresh skills/cross-skill
    breadth and discourages overtime, instead of silently ignoring §3.2
    unless a tenant opts in."""

    preference_weight: int = 1
    overtime_cost_weight: int = 1
    skill_decay_weight: int = 1
    cross_skill_balance_weight: int = 1


@dataclass(frozen=True)
class SolveInput:
    date_range_start: date
    date_range_end: date
    employees: tuple[Employee, ...]
    shifts: tuple[ShiftSlot, ...]
    policy: EmploymentPolicy
    leave_records: tuple[LeaveRecord, ...] = ()
    time_limit_seconds: float = 30.0
    # None: §3.3's bound is not enforced (Phase 2's original behavior).
    fairness: FairnessConfig | None = None
    soft_weights: SoftWeights = field(default_factory=SoftWeights)
    # Per-employee count of undesirable shifts already accrued from prior
    # *published* schedules within the fairness window - the `FairnessLedger`
    # query result (`app/services/fairness_service.py`), computed before
    # `solve()` is ever called since `app/solver/` has no DB access of its
    # own. Ignored when `fairness` is None.
    fairness_history_counts: Mapping[uuid.UUID, int] = field(default_factory=dict)
    # §5/ADR-0057's relaxation categories to loosen for this solve, e.g.
    # `{RELAXATION_CONTRACTED_HOURS}`. Empty (the default) is Phase 2/3's
    # original, fully-hard-constrained behavior - relaxation is something a
    # caller opts into explicitly (`app/solver/relaxation.py`'s search, or a
    # human-approved re-solve), never a default.
    relaxed_categories: frozenset[str] = field(default_factory=frozenset)
    # §2.2 rule 1/ADR-0058's pre-solve fixed/solvable partition (Phase 5).
    # Every `LockedAssignment` here must reference an `employee_id`/
    # `shift_id` already present in `employees`/`shifts` - `solve()` raises
    # `UnknownLockedAssignmentError` otherwise. Empty (the default) is every
    # prior phase's behavior unchanged.
    locked_assignments: tuple[LockedAssignment, ...] = ()


@dataclass(frozen=True)
class Assignment:
    employee_id: uuid.UUID
    shift_id: uuid.UUID
    is_overtime: bool


@dataclass(frozen=True)
class SolveResult:
    # "optimal"/"feasible": a schedule was found (CP-SAT's OPTIMAL vs.
    # FEASIBLE-at-time-limit distinction, both map to ScheduleJob's
    # `completed`). "infeasible": CP-SAT proved no schedule satisfies every
    # hard constraint - a first-class, expected outcome (§2.2 rule 2), never
    # conflated with "unknown": the solver hit its time budget with neither a
    # solution nor a proof of infeasibility - that is a `failed` job, because
    # we genuinely don't know whether a schedule exists (module prompt §0's
    # "no vague sufficiency claims" rule extended to solver outcomes).
    status: str
    assignments: tuple[Assignment, ...] = ()
    solve_duration_ms: int = 0
    # §3.2's objective value (None when no soft terms/fairness applied at
    # all, i.e. Phase 2's pure-feasibility path) - persisted to
    # `ScheduleJob.objective_score` (a Phase 1 column, unused until now).
    objective_value: float | None = None


@dataclass(frozen=True)
class RelaxationSearchResult:
    """§5/ADR-0057's relaxation search outcome (Phase 4) -
    `app/solver/relaxation.py::search_relaxations`'s return value. Always
    produced when a baseline solve comes back `infeasible`; never produced
    (and never needed) otherwise."""

    # The cumulative category set tried, in `RELAXATION_ORDER`, up to and
    # including whichever one made the search stop - either the first
    # combination that solved, or (if `feasible` is False) all of them.
    attempted_categories: tuple[str, ...]
    feasible: bool
    # The feasible `SolveResult` achieved with `attempted_categories`
    # relaxed - only present when `feasible` is True. Not yet persisted as a
    # real `Schedule`/`ShiftAssignment` set - that only happens once a human
    # approves it (§5 point 4's non-negotiable).
    result: SolveResult | None
    # Category -> structured, category-specific violation detail (§5 point
    # 3: "a structured, queryable payload... not just a free-text string").
    cost_summary: Mapping[str, Any]
    explanation: str
