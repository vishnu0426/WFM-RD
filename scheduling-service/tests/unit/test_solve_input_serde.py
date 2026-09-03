"""§5's relaxation-approval flow (Phase 4) depends on `SolveInput` surviving
a serialize -> `ScheduleJob.solve_input_snapshot` (jsonb) -> deserialize
round trip byte-for-byte (well, value-for-value) - a lossy round trip would
mean an approved relaxation re-solves against subtly different data than
what was actually found feasible. Proven here directly, no DB involved
(`solve_input_serde` only produces/consumes plain JSON-safe dicts).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime, timedelta

from app.services import solve_input_serde
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


def _build_solve_input() -> SolveInput:
    day = date(2026, 3, 2)
    skill_id = uuid.uuid4()
    shift = ShiftSlot(
        id=uuid.uuid4(),
        start=datetime(2026, 3, 2, 9, tzinfo=UTC),
        end=datetime(2026, 3, 2, 17, tzinfo=UTC),
        required_headcount=2,
        required_skill_id=skill_id,
        break_minutes=30,
    )
    employee = Employee(
        id=uuid.uuid4(),
        contract_hours_per_week=32.5,
        overtime_approved=True,
        skills=(EmployeeSkill(skill_id=skill_id, expires_at=day + timedelta(days=90), decay_score=0.4),),
        preferred_shift_ids=frozenset({shift.id}),
    )
    return SolveInput(
        date_range_start=day,
        date_range_end=day + timedelta(days=6),
        employees=(employee,),
        shifts=(shift,),
        policy=EmploymentPolicy(
            max_consecutive_working_days=5,
            min_rest_hours_between_shifts=11.0,
            min_shift_length_minutes=240,
            max_shift_length_minutes=600,
            mandatory_break_after_hours=6.0,
            mandatory_break_minutes=30,
        ),
        leave_records=(LeaveRecord(employee_id=uuid.uuid4(), start=day, end=day + timedelta(days=1)),),
        time_limit_seconds=45.0,
        fairness=FairnessConfig(
            rolling_period_weeks=3,
            tolerance=2,
            include_weekends=False,
            night_start_hour=23,
            night_end_hour=5,
            holiday_dates=frozenset({day + timedelta(days=3)}),
        ),
        soft_weights=SoftWeights(
            preference_weight=2, overtime_cost_weight=0, skill_decay_weight=3, cross_skill_balance_weight=1
        ),
        fairness_history_counts={employee.id: 4},
        # Phase 5/ADR-0058: must round-trip so an infeasible reoptimize job's
        # later-approved relaxation still honors its forced variables - see
        # `job_service.approve_relaxation`'s `dataclasses.replace` fix.
        locked_assignments=(
            LockedAssignment(employee_id=employee.id, shift_id=shift.id, assignment_source="swap"),
        ),
    )


def test_serialize_produces_a_json_safe_payload() -> None:
    serialized = solve_input_serde.serialize(_build_solve_input())
    # Round-trips through real JSON encoding, not just Python dict equality -
    # this is what actually happens going into/out of a jsonb column.
    json.loads(json.dumps(serialized))


def test_deserialize_reverses_serialize_exactly() -> None:
    original = _build_solve_input()
    restored = solve_input_serde.deserialize(json.loads(json.dumps(solve_input_serde.serialize(original))))

    assert restored.date_range_start == original.date_range_start
    assert restored.date_range_end == original.date_range_end
    assert restored.time_limit_seconds == original.time_limit_seconds
    assert restored.fairness_history_counts == original.fairness_history_counts

    assert len(restored.employees) == 1
    restored_employee, original_employee = restored.employees[0], original.employees[0]
    assert restored_employee.id == original_employee.id
    assert restored_employee.contract_hours_per_week == original_employee.contract_hours_per_week
    assert restored_employee.overtime_approved == original_employee.overtime_approved
    assert restored_employee.preferred_shift_ids == original_employee.preferred_shift_ids
    assert restored_employee.skills == original_employee.skills

    assert restored.shifts == original.shifts
    assert restored.policy == original.policy
    assert restored.leave_records == original.leave_records
    assert restored.fairness == original.fairness
    assert restored.soft_weights == original.soft_weights
    assert restored.locked_assignments == original.locked_assignments


def test_deserialize_handles_no_fairness_configured() -> None:
    original = _build_solve_input()
    without_fairness = SolveInput(
        date_range_start=original.date_range_start,
        date_range_end=original.date_range_end,
        employees=original.employees,
        shifts=original.shifts,
        policy=original.policy,
    )
    restored = solve_input_serde.deserialize(solve_input_serde.serialize(without_fairness))
    assert restored.fairness is None
    assert restored.fairness_history_counts == {}
