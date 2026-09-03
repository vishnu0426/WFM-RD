"""Pydantic-input -> solver-dataclass conversion, factored out of
`app/api/v1/jobs.py`'s original `_build_solve_input` so Phase 5's reoptimize
endpoint (`app/api/v1/schedules.py`) can build the same `Employee`/
`ShiftSlot`/`EmploymentPolicy`/`LeaveRecord`/`SoftWeights`/`FairnessConfig`
values from the same wire shapes without re-deriving this mapping by hand a
second time and risking the two copies drifting apart.
"""

from __future__ import annotations

from app.api.v1.schemas import (
    EmployeeInput,
    EmploymentPolicyInput,
    FairnessConfigInput,
    LeaveRecordInput,
    ShiftSlotInput,
    SoftWeightsInput,
)
from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    FairnessConfig,
    LeaveRecord,
    ShiftSlot,
    SoftWeights,
)


def to_employee(e: EmployeeInput) -> Employee:
    return Employee(
        id=e.id,
        contract_hours_per_week=e.contract_hours_per_week,
        overtime_approved=e.overtime_approved,
        skills=tuple(
            EmployeeSkill(skill_id=s.skill_id, expires_at=s.expires_at, decay_score=s.decay_score)
            for s in e.skills
        ),
        preferred_shift_ids=frozenset(e.preferred_shift_ids),
        org_unit_id=e.org_unit_id,
    )


def to_shift_slot(s: ShiftSlotInput) -> ShiftSlot:
    # `required_headcount` is `int | None` on `ShiftSlotInput` (Phase 6,
    # ADR-0059's forecast-derived-headcount pull) - every caller of this
    # function today (`ReoptimizeScheduleRequest`) validates it's present
    # before this runs (see that schema's own `model_validator`);
    # `submit_schedule_job`'s own gRPC-pull path builds `ShiftSlot` directly
    # rather than through this function, since it may need to derive the
    # value first.
    assert s.required_headcount is not None
    return ShiftSlot(
        id=s.id,
        start=s.start,
        end=s.end,
        required_headcount=s.required_headcount,
        required_skill_id=s.required_skill_id,
        break_minutes=s.break_minutes,
        org_unit_id=s.org_unit_id,
    )


def to_policy(policy: EmploymentPolicyInput) -> EmploymentPolicy:
    return EmploymentPolicy(
        max_consecutive_working_days=policy.max_consecutive_working_days,
        min_rest_hours_between_shifts=policy.min_rest_hours_between_shifts,
        min_shift_length_minutes=policy.min_shift_length_minutes,
        max_shift_length_minutes=policy.max_shift_length_minutes,
        mandatory_break_after_hours=policy.mandatory_break_after_hours,
        mandatory_break_minutes=policy.mandatory_break_minutes,
    )


def to_leave_record(lr: LeaveRecordInput) -> LeaveRecord:
    return LeaveRecord(employee_id=lr.employee_id, start=lr.date_range.start, end=lr.date_range.end)


def to_soft_weights(weights: SoftWeightsInput) -> SoftWeights:
    return SoftWeights(
        preference_weight=weights.preference_weight,
        overtime_cost_weight=weights.overtime_cost_weight,
        skill_decay_weight=weights.skill_decay_weight,
        cross_skill_balance_weight=weights.cross_skill_balance_weight,
    )


def to_fairness_config(fairness: FairnessConfigInput) -> FairnessConfig:
    return FairnessConfig(
        rolling_period_weeks=fairness.rolling_period_weeks,
        tolerance=fairness.tolerance,
        include_weekends=fairness.include_weekends,
        night_start_hour=fairness.night_start_hour,
        night_end_hour=fairness.night_end_hour,
        holiday_dates=frozenset(fairness.holiday_dates),
    )
