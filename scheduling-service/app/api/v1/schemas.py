"""Request/response models for §4.1's REST job contract. Field names match
§2.1's `ScheduleJob` entity and §4.1's request shape (`orgUnitId`,
`dateRange`, `forecastRunId`, `constraintConfig`) directly - `populate_by_name`
+ camelCase aliases so the wire format matches the rest of the platform's
convention (GraphQL/TypeScript camelCase), same pattern as Module 03's own
`schemas.py`.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(field_name: str) -> str:
    first, *rest = field_name.split("_")
    return first + "".join(word.capitalize() for word in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class DateRange(CamelModel):
    start: date
    end: date

    @model_validator(mode="after")
    def _end_not_before_start(self) -> DateRange:
        # Mirrors `ck_schedule_jobs_date_range` (0001_initial_schema.py) at
        # the API boundary - rejected here as a normal 422 validation error,
        # not left to surface as an opaque IntegrityError/500 from the DB
        # constraint that exists as defense in depth, not as the primary
        # validation path.
        if self.end < self.start:
            raise ValueError("dateRange.end must not be before dateRange.start")
        return self


class EmployeeSkillInput(CamelModel):
    skill_id: uuid.UUID
    expires_at: date | None = None
    # §3.2's skill-decay soft term (Module 02's `EmployeeSkill.decay_score`
    # convention: 0.0 = fully fresh, higher = more decayed).
    decay_score: float = Field(default=0.0, ge=0, le=1)


class EmployeeInput(CamelModel):
    id: uuid.UUID
    contract_hours_per_week: float = Field(gt=0)
    overtime_approved: bool = False
    skills: list[EmployeeSkillInput] = Field(default_factory=list)
    # §3.2's employee-shift-preference soft term - ids from this request's
    # own `shiftSlots`.
    preferred_shift_ids: list[uuid.UUID] = Field(default_factory=list)
    # Phase 7 (ADR-0061): which site this employee's home base is, for
    # `app/solver/decomposition.py`'s per-site partitioning (mirrors
    # `ShiftSlotInput.org_unit_id`). `None` (the default) means this
    # employee never participates in decomposition grouping - every
    # pre-Phase-7 caller's exact prior behavior.
    org_unit_id: uuid.UUID | None = None


class LeaveRecordInput(CamelModel):
    employee_id: uuid.UUID
    date_range: DateRange


class ShiftSlotInput(CamelModel):
    id: uuid.UUID
    start: datetime
    end: datetime
    # Phase 6 (ADR-0059): `None` (the default) is pulled from
    # `ForecastService.GetForecastRequirements` (the max required headcount
    # across every forecast interval this shift's own window overlaps) -
    # an explicit value always wins outright, never merged/averaged with
    # the pulled one.
    required_headcount: int | None = Field(default=None, ge=0)
    required_skill_id: uuid.UUID | None = None
    break_minutes: int = Field(default=0, ge=0)
    # Phase 7 (ADR-0061): which site this shift belongs to, for
    # `app/solver/decomposition.py`'s per-site partitioning. `None` (the
    # default) means this shift never participates in decomposition - every
    # pre-Phase-7 caller's exact prior behavior.
    org_unit_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _end_after_start(self) -> ShiftSlotInput:
        if self.end <= self.start:
            raise ValueError("shift end must be after shift start")
        return self


class EmploymentPolicyInput(CamelModel):
    max_consecutive_working_days: int = Field(gt=0)
    min_rest_hours_between_shifts: float = Field(ge=0)
    min_shift_length_minutes: int = Field(gt=0)
    max_shift_length_minutes: int | None = Field(default=None, gt=0)
    mandatory_break_after_hours: float | None = Field(default=None, gt=0)
    mandatory_break_minutes: int | None = Field(default=None, ge=0)


class SoftWeightsInput(CamelModel):
    """§3.2's weighted, tradeable objective terms. Defaults are all a modest
    positive weight, not 0 - submitting no explicit weights still produces a
    schedule that prefers preferences/fresh skills/cross-skill breadth and
    discourages overtime/overstaffing, rather than silently ignoring §3.2
    unless a tenant opts in."""

    preference_weight: int = Field(default=1, ge=0)
    overtime_cost_weight: int = Field(default=1, ge=0)
    skill_decay_weight: int = Field(default=1, ge=0)
    cross_skill_balance_weight: int = Field(default=1, ge=0)


class FairnessConfigInput(CamelModel):
    """§3.3's bounded, auditable fairness constraint. "Undesirable shift" is
    itself tenant-configurable (weekend/night/holiday), not a fixed platform
    definition - `nightStartHour`/`nightEndHour` accept `null` to disable
    the night rule entirely (e.g. a tenant that only cares about weekends)."""

    rolling_period_weeks: int = Field(default=4, gt=0)
    tolerance: int = Field(default=1, ge=0)
    include_weekends: bool = True
    night_start_hour: int | None = Field(default=22, ge=0, le=23)
    night_end_hour: int | None = Field(default=6, ge=0, le=23)
    holiday_dates: list[date] = Field(default_factory=list)


class ConstraintConfigInput(CamelModel):
    """§2.2 rule 3's tenant-configurable jsonb, given a concrete shape in
    Phase 3 as promised in Phase 1's design doc ("not validated against a
    concrete shape yet - that's Phase 3's fairness-as-a-bounded-constraint
    work"). `fairness: null` (the default) means §3.3's bound is not
    enforced for this solve - the same "opt-in, not opt-out" posture Phase
    2 already used for `policy`/`shiftSlots`."""

    fairness: FairnessConfigInput | None = None
    soft_weights: SoftWeightsInput = Field(default_factory=SoftWeightsInput)


class ScheduleJobRequest(CamelModel):
    org_unit_id: uuid.UUID
    date_range: DateRange
    forecast_run_id: uuid.UUID
    constraint_config: ConstraintConfigInput = Field(default_factory=ConstraintConfigInput)
    # `shiftSlots` empty/omitted still means Phase 1's original behavior
    # (parked at `status: queued`, nothing solves it) - unchanged since
    # Phase 2. `policy`/`roster` used to share that same "omitted = don't
    # solve" meaning (ADR-0055); as of Phase 6 (ADR-0059) they instead mean
    # "pull via gRPC" when omitted - `policy: null`/`roster` key absent
    # entirely pulls from PolicyService/EmployeeService, an explicit value
    # always wins outright. `roster: []` (an explicit empty array, distinct
    # from omitting the key) still means "explicitly zero employees" - never
    # triggers a pull, same as every prior phase. `leave_records` joins this
    # same optional-field-triggers-pull group as of Module 06 Phase 5
    # (ADR-0078) - previously `list[...] = Field(default_factory=list)`,
    # which had no wire-representable "omitted, please pull" state at all
    # (an omitted key and `leave_records: []` were indistinguishable). Now
    # `None`/key-absent pulls from `LeaveService.GetUnavailability`; an
    # explicit list (including `[]`) wins outright, no merge - the same
    # "a Scheduler exploring a scenario is a legitimate manual override"
    # reasoning ADR-0059 gives for roster/policy.
    policy: EmploymentPolicyInput | None = None
    roster: list[EmployeeInput] | None = None
    shift_slots: list[ShiftSlotInput] = Field(default_factory=list)
    leave_records: list[LeaveRecordInput] | None = None


class ScheduleJobResponse(CamelModel):
    job_id: uuid.UUID
    status: str


class ScheduleExplanationResponse(CamelModel):
    """§2's `ScheduleExplanation` - Module 10's write-back after generating
    an explanation off this service's `agno.scheduling.job.completed.v1`
    event (Phase 6, ADR-0059). This module only requests and stores it -
    the LLM call itself is Module 10's, per §1's mandated-stack table and
    §10's explicit non-goal."""

    id: uuid.UUID
    summary_text: str | None
    top_constraints: dict[str, Any] | None
    trade_offs: dict[str, Any] | None
    generated_by_model_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class SubmitExplanationRequest(CamelModel):
    """Module 10's own request body when it calls back in with a generated
    explanation. Upserts - a resubmission for the same `jobId` (e.g.
    Module 10 regenerating) replaces the prior explanation rather than
    erroring or accumulating duplicate rows."""

    summary_text: str
    top_constraints: dict[str, Any] = Field(default_factory=dict)
    trade_offs: dict[str, Any] = Field(default_factory=dict)
    generated_by_model_id: uuid.UUID | None = None


class ScheduleJobDetail(CamelModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    org_unit_id: uuid.UUID
    forecast_run_id: uuid.UUID
    date_range: DateRange
    status: str
    constraint_config: dict[str, Any]
    requested_by: uuid.UUID | None
    solve_duration_ms: int | None
    objective_score: Decimal | None
    decomposition_plan: dict[str, Any] | None
    relaxations_applied: dict[str, Any] | None
    requested_at: datetime
    completed_at: datetime | None
    # §4.1's stated shape: `{ jobId, status, schedule?, explanation?,
    # conflicts? }` - `None` until Module 10 submits one (Phase 6, see
    # SubmitExplanationRequest above); this module never generates it.
    explanation: ScheduleExplanationResponse | None = None


class ShiftAssignmentResponse(CamelModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    shift_start: datetime
    shift_end: datetime
    skill_id: uuid.UUID | None
    assignment_source: str
    is_overtime: bool
    locked: bool


class ScheduleResponse(CamelModel):
    id: uuid.UUID
    schedule_job_id: uuid.UUID
    status: str
    published_at: datetime | None
    published_by: uuid.UUID | None
    assignments: list[ShiftAssignmentResponse]


class EmployeeShiftAssignmentResponse(CamelModel):
    """`GET /v1/scheduling/employees/{employeeId}/shift-assignments` (added
    for Module 05's `scheduled_activity` pre-load, §2.2 rule 2 there) -
    `ShiftAssignmentResponse`'s fields plus `schedule_id`/`published_at`,
    since a caller here doesn't already know which schedule it's asking
    about the way every other assignment-returning endpoint does. Only
    assignments belonging to a `status: published` `Schedule` are ever
    returned - see `schedule_service.list_employee_shift_assignments`."""

    id: uuid.UUID
    employee_id: uuid.UUID
    schedule_id: uuid.UUID
    shift_start: datetime
    shift_end: datetime
    skill_id: uuid.UUID | None
    assignment_source: str
    is_overtime: bool
    locked: bool
    published_at: datetime


class OverrideAssignmentRequest(CamelModel):
    """§4.2's `overrideAssignment` mutation, this service's REST equivalent
    - reassigns an existing `ShiftAssignment` to `employeeId` and marks it
    `assignment_source: manual_override` per §2.2 rule 1."""

    employee_id: uuid.UUID


class ReoptimizeScheduleRequest(CamelModel):
    """Phase 5's re-optimization request - the same solve-input shape as
    `ScheduleJobRequest` minus `orgUnitId`/`dateRange`/`forecastRunId`
    (those come from the schedule being reoptimized, not resupplied) and
    minus the ADR-0055 "all optional" posture (`policy`/`shiftSlots` are
    required here - there is no "parked at queued" behavior for a
    reoptimize, it always solves). `shiftSlots` must include every shift
    this schedule's currently-locked assignments occupy, matched by
    `(start, end, requiredSkillId)` - see `job_service.reoptimize_schedule`'s
    docstring for why matching isn't done by id.

    `requiredHeadcount` is required on every shift here too - Phase 6's
    forecast-derived-headcount pull (ADR-0059) is scoped to
    `ScheduleJobRequest` only; extending it to reoptimize would need the
    locked-shift-matching logic to also reason about a shift whose headcount
    isn't known until after the forecast pull, which ADR-0059 deliberately
    left out of this phase's scope."""

    policy: EmploymentPolicyInput
    roster: list[EmployeeInput] = Field(default_factory=list)
    shift_slots: list[ShiftSlotInput]
    leave_records: list[LeaveRecordInput] = Field(default_factory=list)
    constraint_config: ConstraintConfigInput = Field(default_factory=ConstraintConfigInput)

    @model_validator(mode="after")
    def _every_shift_has_a_required_headcount(self) -> ReoptimizeScheduleRequest:
        missing = [str(s.id) for s in self.shift_slots if s.required_headcount is None]
        if missing:
            raise ValueError(
                f"requiredHeadcount is required on every shift for reoptimize: missing on {missing}"
            )
        return self


class ScheduleConflictResponse(CamelModel):
    """§2's `ScheduleConflict` read/write surface - written by
    `schedule_service.override_assignment`'s `double_booking` check (Phase
    5/ADR-0058's conflict-detection scope). This docstring used to claim
    resolving a conflict was Node/Module 01's GraphQL mutation to build -
    verified that mutation doesn't exist there, so the transition lives
    here instead (`POST .../conflicts/{conflictId}/resolve`), matching
    intraday-service's `AdherenceException` open/acknowledged/resolved
    shape rather than leaving conflicts permanently read-only."""

    id: uuid.UUID
    conflict_type: str
    affected_employee_id: uuid.UUID
    status: str
    suggested_resolution: dict[str, Any] | None
    created_at: datetime


class ResolveScheduleConflictRequest(CamelModel):
    status: str = Field(pattern="^(acknowledged|resolved)$")


class FairnessAuditEmployeeEntry(CamelModel):
    employee_id: uuid.UUID
    undesirable_shift_count: int
    exceeded_tolerance: bool


class FairnessAuditResponse(CamelModel):
    """The module prompt's own compliance-auditor bar: "show me the fairness
    tolerance policy in effect for period X and prove no employee exceeded
    it" - a real, answerable API call, not just a documentation claim.
    `tolerance` is caller-supplied (the auditor's own policy question, e.g.
    "would this have violated a *stricter* tolerance than what was actually
    configured at solve time") rather than auto-derived from historical
    `ScheduleJob.constraint_config` rows - see the design doc's explicit
    assumptions for why."""

    period_start: date
    period_end: date
    tolerance: int
    average_undesirable_shift_count: float
    employees: list[FairnessAuditEmployeeEntry]


# ---- Shift templates ("Shifts" in the reference console's own menu) ----


class ShiftTemplateRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    start_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    break_minutes: int = Field(default=0, ge=0)
    required_skill_id: uuid.UUID | None = None
    default_headcount: int = Field(default=1, ge=0)


class ShiftTemplateResponse(ShiftTemplateRequest):
    id: uuid.UUID


class ShiftTemplateUpdate(CamelModel):
    """`PATCH /v1/scheduling/shift-templates/{id}` — every field declared
    fresh (not inherited from `ShiftTemplateRequest`) and optional, so a
    field simply absent from the request body is left untouched rather than
    reset to a default. The router only forwards fields the caller actually
    set (`model_dump(exclude_unset=True)`)."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    start_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    break_minutes: int | None = Field(default=None, ge=0)
    required_skill_id: uuid.UUID | None = None
    default_headcount: int | None = Field(default=None, ge=0)


# ---- Work patterns ("Work Patterns" in the reference console's own menu) ----


class WorkPatternRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    # One entry per day of the cycle — a shift template id, or null for an
    # off day. Length is the cycle length; no separate field for it.
    days: list[uuid.UUID | None] = Field(min_length=1, max_length=28)


class WorkPatternResponse(WorkPatternRequest):
    id: uuid.UUID


class WorkPatternUpdate(CamelModel):
    """`PATCH /v1/scheduling/work-patterns/{id}` — see `ShiftTemplateUpdate`
    for why every field is declared fresh and optional rather than inherited
    from `WorkPatternRequest`."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    days: list[uuid.UUID | None] | None = Field(default=None, min_length=1, max_length=28)


# ---- Staffing profiles ("Staffing Profiles" under Scenarios in the reference console's own menu) ----


class StaffingProfileEntryInput(CamelModel):
    shift_template_id: uuid.UUID
    required_headcount: int = Field(ge=0)


class StaffingProfileRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    entries: list[StaffingProfileEntryInput] = Field(min_length=1, max_length=50)


class StaffingProfileResponse(StaffingProfileRequest):
    id: uuid.UUID


class StaffingProfileUpdate(CamelModel):
    """`PATCH /v1/scheduling/staffing-profiles/{id}` — see
    `ShiftTemplateUpdate` for why every field is declared fresh and optional
    rather than inherited from `StaffingProfileRequest`."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    entries: list[StaffingProfileEntryInput] | None = Field(default=None, min_length=1, max_length=50)


# ---- Shift event requests ("Shift Events"/"VTO Events"/"OT Extensions" ----
# ---- in the reference console's own menu) ----


class CreateShiftEventRequestInput(CamelModel):
    employee_id: uuid.UUID
    event_type: str = Field(pattern="^(shift_change|vto|overtime_extension)$")
    shift_date: date
    requested_hours: Decimal | None = Field(default=None, ge=0)
    reason: str = Field(min_length=1, max_length=500)


class DecideShiftEventRequestInput(CamelModel):
    decision: str = Field(pattern="^(approved|rejected)$")
    decision_reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _rejection_requires_a_reason(self) -> DecideShiftEventRequestInput:
        if self.decision == "rejected" and not self.decision_reason:
            raise ValueError("decisionReason is required when decision is 'rejected'")
        return self


class ShiftEventRequestResponse(CamelModel):
    id: uuid.UUID
    employee_id: uuid.UUID
    event_type: str
    shift_date: date
    requested_hours: Decimal | None
    reason: str
    status: str
    decision_reason: str | None
    requested_by: uuid.UUID | None
    decided_by: uuid.UUID | None
    decided_at: datetime | None
    created_at: datetime


# ---- Project rules ("Project Rules" under Work Rules in the reference console's own menu) ----


class ProjectRuleRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    max_consecutive_working_days: int = Field(gt=0)
    min_rest_hours_between_shifts: Decimal = Field(ge=0)
    min_shift_length_minutes: int = Field(gt=0)
    max_shift_length_minutes: int | None = Field(default=None, gt=0)
    allows_overtime: bool = True


class ProjectRuleResponse(ProjectRuleRequest):
    id: uuid.UUID


class ProjectRuleUpdateRequest(CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    max_consecutive_working_days: int | None = Field(default=None, gt=0)
    min_rest_hours_between_shifts: Decimal | None = Field(default=None, ge=0)
    min_shift_length_minutes: int | None = Field(default=None, gt=0)
    max_shift_length_minutes: int | None = Field(default=None, gt=0)
    allows_overtime: bool | None = None
