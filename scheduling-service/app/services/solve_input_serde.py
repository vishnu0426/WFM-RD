"""Serialize/deserialize `SolveInput` to/from plain JSON-safe dicts, for
`ScheduleJob.solve_input_snapshot` (§5's relaxation-approval flow, Phase 4,
migration 0003). Lives in the service layer, not `app/solver/`, since this
is a persistence concern `job_service` needs, not a capability the pure
solver package itself needs to expose (`app/solver/`'s own module docstrings
are explicit about staying independent of how data arrives/is stored).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from app.solver.types import (
    Employee,
    EmployeeSkill,
    EmploymentPolicy,
    FairnessConfig,
    LeaveRecord,
    LockedAssignment,
    ShiftSlot,
    SoftWeights,
    SolveInput,
)


def serialize(solve_input: SolveInput) -> dict[str, Any]:
    return {
        "dateRangeStart": solve_input.date_range_start.isoformat(),
        "dateRangeEnd": solve_input.date_range_end.isoformat(),
        "employees": [_serialize_employee(e) for e in solve_input.employees],
        "shifts": [_serialize_shift(s) for s in solve_input.shifts],
        "policy": _serialize_policy(solve_input.policy),
        "leaveRecords": [_serialize_leave(lr) for lr in solve_input.leave_records],
        "timeLimitSeconds": solve_input.time_limit_seconds,
        "fairness": _serialize_fairness(solve_input.fairness) if solve_input.fairness is not None else None,
        "softWeights": _serialize_soft_weights(solve_input.soft_weights),
        "fairnessHistoryCounts": {str(k): v for k, v in solve_input.fairness_history_counts.items()},
        # Phase 5/ADR-0058: must round-trip so a reoptimize job that later
        # goes infeasible, gets its relaxation approved
        # (`job_service.approve_relaxation`), and is re-solved from this
        # snapshot doesn't silently lose the locked-assignment forcing.
        "lockedAssignments": [_serialize_locked_assignment(la) for la in solve_input.locked_assignments],
    }


def deserialize(data: dict[str, Any]) -> SolveInput:
    fairness_data = data.get("fairness")
    return SolveInput(
        date_range_start=date.fromisoformat(data["dateRangeStart"]),
        date_range_end=date.fromisoformat(data["dateRangeEnd"]),
        employees=tuple(_deserialize_employee(e) for e in data["employees"]),
        shifts=tuple(_deserialize_shift(s) for s in data["shifts"]),
        policy=_deserialize_policy(data["policy"]),
        leave_records=tuple(_deserialize_leave(lr) for lr in data["leaveRecords"]),
        time_limit_seconds=data["timeLimitSeconds"],
        fairness=_deserialize_fairness(fairness_data) if fairness_data is not None else None,
        soft_weights=_deserialize_soft_weights(data["softWeights"]),
        fairness_history_counts={
            uuid.UUID(k): v for k, v in data.get("fairnessHistoryCounts", {}).items()
        },
        locked_assignments=tuple(
            _deserialize_locked_assignment(la) for la in data.get("lockedAssignments", [])
        ),
    )


def _serialize_employee(employee: Employee) -> dict[str, Any]:
    return {
        "id": str(employee.id),
        "contractHoursPerWeek": employee.contract_hours_per_week,
        "overtimeApproved": employee.overtime_approved,
        "skills": [
            {
                "skillId": str(skill.skill_id),
                "expiresAt": skill.expires_at.isoformat() if skill.expires_at else None,
                "decayScore": skill.decay_score,
            }
            for skill in employee.skills
        ],
        "preferredShiftIds": [str(shift_id) for shift_id in employee.preferred_shift_ids],
    }


def _deserialize_employee(data: dict[str, Any]) -> Employee:
    return Employee(
        id=uuid.UUID(data["id"]),
        contract_hours_per_week=data["contractHoursPerWeek"],
        overtime_approved=data["overtimeApproved"],
        skills=tuple(
            EmployeeSkill(
                skill_id=uuid.UUID(skill["skillId"]),
                expires_at=date.fromisoformat(skill["expiresAt"]) if skill.get("expiresAt") else None,
                decay_score=skill.get("decayScore", 0.0),
            )
            for skill in data.get("skills", [])
        ),
        preferred_shift_ids=frozenset(uuid.UUID(sid) for sid in data.get("preferredShiftIds", [])),
    )


def _serialize_shift(shift: ShiftSlot) -> dict[str, Any]:
    return {
        "id": str(shift.id),
        "start": shift.start.isoformat(),
        "end": shift.end.isoformat(),
        "requiredHeadcount": shift.required_headcount,
        "requiredSkillId": str(shift.required_skill_id) if shift.required_skill_id else None,
        "breakMinutes": shift.break_minutes,
    }


def _deserialize_shift(data: dict[str, Any]) -> ShiftSlot:
    return ShiftSlot(
        id=uuid.UUID(data["id"]),
        start=datetime.fromisoformat(data["start"]),
        end=datetime.fromisoformat(data["end"]),
        required_headcount=data["requiredHeadcount"],
        required_skill_id=uuid.UUID(data["requiredSkillId"]) if data.get("requiredSkillId") else None,
        break_minutes=data.get("breakMinutes", 0),
    )


def _serialize_policy(policy: EmploymentPolicy) -> dict[str, Any]:
    return {
        "maxConsecutiveWorkingDays": policy.max_consecutive_working_days,
        "minRestHoursBetweenShifts": policy.min_rest_hours_between_shifts,
        "minShiftLengthMinutes": policy.min_shift_length_minutes,
        "maxShiftLengthMinutes": policy.max_shift_length_minutes,
        "mandatoryBreakAfterHours": policy.mandatory_break_after_hours,
        "mandatoryBreakMinutes": policy.mandatory_break_minutes,
    }


def _deserialize_policy(data: dict[str, Any]) -> EmploymentPolicy:
    return EmploymentPolicy(
        max_consecutive_working_days=data["maxConsecutiveWorkingDays"],
        min_rest_hours_between_shifts=data["minRestHoursBetweenShifts"],
        min_shift_length_minutes=data["minShiftLengthMinutes"],
        max_shift_length_minutes=data.get("maxShiftLengthMinutes"),
        mandatory_break_after_hours=data.get("mandatoryBreakAfterHours"),
        mandatory_break_minutes=data.get("mandatoryBreakMinutes"),
    )


def _serialize_leave(record: LeaveRecord) -> dict[str, Any]:
    return {
        "employeeId": str(record.employee_id),
        "start": record.start.isoformat(),
        "end": record.end.isoformat(),
    }


def _deserialize_leave(data: dict[str, Any]) -> LeaveRecord:
    return LeaveRecord(
        employee_id=uuid.UUID(data["employeeId"]),
        start=date.fromisoformat(data["start"]),
        end=date.fromisoformat(data["end"]),
    )


def _serialize_fairness(fairness: FairnessConfig) -> dict[str, Any]:
    return {
        "rollingPeriodWeeks": fairness.rolling_period_weeks,
        "tolerance": fairness.tolerance,
        "includeWeekends": fairness.include_weekends,
        "nightStartHour": fairness.night_start_hour,
        "nightEndHour": fairness.night_end_hour,
        "holidayDates": [d.isoformat() for d in sorted(fairness.holiday_dates)],
    }


def _deserialize_fairness(data: dict[str, Any]) -> FairnessConfig:
    return FairnessConfig(
        rolling_period_weeks=data["rollingPeriodWeeks"],
        tolerance=data["tolerance"],
        include_weekends=data["includeWeekends"],
        night_start_hour=data.get("nightStartHour"),
        night_end_hour=data.get("nightEndHour"),
        holiday_dates=frozenset(date.fromisoformat(d) for d in data.get("holidayDates", [])),
    )


def _serialize_locked_assignment(locked: LockedAssignment) -> dict[str, Any]:
    return {
        "employeeId": str(locked.employee_id),
        "shiftId": str(locked.shift_id),
        "assignmentSource": locked.assignment_source,
    }


def _deserialize_locked_assignment(data: dict[str, Any]) -> LockedAssignment:
    return LockedAssignment(
        employee_id=uuid.UUID(data["employeeId"]),
        shift_id=uuid.UUID(data["shiftId"]),
        assignment_source=data.get("assignmentSource", "manual_override"),
    )


def _serialize_soft_weights(weights: SoftWeights) -> dict[str, Any]:
    return {
        "preferenceWeight": weights.preference_weight,
        "overtimeCostWeight": weights.overtime_cost_weight,
        "skillDecayWeight": weights.skill_decay_weight,
        "crossSkillBalanceWeight": weights.cross_skill_balance_weight,
    }


def _deserialize_soft_weights(data: dict[str, Any]) -> SoftWeights:
    return SoftWeights(
        preference_weight=data["preferenceWeight"],
        overtime_cost_weight=data["overtimeCostWeight"],
        skill_decay_weight=data["skillDecayWeight"],
        cross_skill_balance_weight=data["crossSkillBalanceWeight"],
    )
