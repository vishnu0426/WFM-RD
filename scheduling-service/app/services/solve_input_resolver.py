"""Builds a `SolveInput` from a `ScheduleJobRequest`, resolving `roster`/
`policy`/each shift's `requiredHeadcount`/`leaveRecords` via gRPC when the
request omits them (ADR-0059, `leaveRecords` added by Module 06 Phase 5/
ADR-0078). Phase 6 ran this inline in the HTTP handler; Phase 7 (ADR-0060)
moved it here so `app/worker.py` can call it too - §4.3's own "the worker
pulls exactly what it needs at solve time" is now literally true, not just
a description of where the code happens to run.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable
from datetime import date, timedelta
from typing import TypeVar

import grpc
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.schemas import ScheduleJobRequest, ShiftSlotInput
from app.core.errors import ShiftHeadcountUndeterminedError, UpstreamDataUnavailableError
from app.grpc_clients import (
    calendar_client,
    compliance_client,
    employee_client,
    forecast_client,
    leave_client,
    policy_client,
)
from app.grpc_clients.channels import (
    get_attendance_channel,
    get_compliance_channel,
    get_core_channel,
    get_forecasting_channel,
)
from app.grpc_clients.retry import GrpcCallExhaustedError
from app.services import fairness_service, solve_input_conversion
from app.solver.types import Employee, EmploymentPolicy, FairnessConfig, LeaveRecord, ShiftSlot, SolveInput

logger = logging.getLogger(__name__)

_T = TypeVar("_T")


async def _call_upstream(service: str, method: str, awaitable: Awaitable[_T]) -> _T:
    """Wraps a `grpc_clients` call so both failure modes ADR-0059 Decision 5
    names - retries exhausted (`GrpcCallExhaustedError`) and an immediate
    non-retryable RPC error - surface as the same `UpstreamDataUnavailableError`
    (503). Raised from `app.worker`'s `execute_job`, which maps it onto the
    claimed job's own terminal `failed` state (ADR-0060) - there is no HTTP
    response to attach a 503 to anymore once solving moved off the request
    thread."""
    try:
        return await awaitable
    except GrpcCallExhaustedError as exc:
        raise UpstreamDataUnavailableError(service, method, str(exc.last_error.details())) from exc
    except grpc.aio.AioRpcError as exc:
        raise UpstreamDataUnavailableError(service, method, str(exc.details())) from exc


async def _resolve_roster(body: ScheduleJobRequest, *, tenant_id: uuid.UUID) -> tuple[Employee, ...]:
    if body.roster is not None:
        return tuple(solve_input_conversion.to_employee(e) for e in body.roster)
    return await _call_upstream(
        "EmployeeService",
        "GetSchedulableEmployees",
        employee_client.get_schedulable_roster(
            get_core_channel(), tenant_id=tenant_id, org_unit_id=body.org_unit_id
        ),
    )


async def _resolve_policy(body: ScheduleJobRequest, *, tenant_id: uuid.UUID) -> EmploymentPolicy:
    if body.policy is not None:
        policy = solve_input_conversion.to_policy(body.policy)
    else:
        policy = await _call_upstream(
            "PolicyService",
            "GetActivePolicy",
            policy_client.get_active_employment_policy(
                get_core_channel(),
                tenant_id=tenant_id,
                org_unit_id=body.org_unit_id,
                as_of=body.date_range.start,
            ),
        )
    return await _merge_compliance_floor(
        policy, tenant_id=tenant_id, org_unit_id=body.org_unit_id, as_of=body.date_range.start
    )


def _stricter_lower(policy_value: float | None, floor_value: object) -> float | None:
    """`floor_value` wins whenever `policy_value` doesn't specify a tighter
    (lower) cap of its own - a policy with no cap at all (`None`) is never
    stricter than a floor that specifies one."""
    if not isinstance(floor_value, int | float):
        return policy_value
    if policy_value is None:
        return float(floor_value)
    return min(policy_value, float(floor_value))


def _stricter_higher(policy_value: float | None, floor_value: object) -> float | None:
    """Mirror of `_stricter_lower` for a field where a *higher* value is
    more protective (more required rest, a longer guaranteed minimum, a
    longer mandatory break)."""
    if not isinstance(floor_value, int | float):
        return policy_value
    if policy_value is None:
        return float(floor_value)
    return max(policy_value, float(floor_value))


async def _merge_compliance_floor(
    policy: EmploymentPolicy, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, as_of: date
) -> EmploymentPolicy:
    """§0.6/ADR-0102: merges Module 08's jurisdiction-specific legal floor
    into the already-resolved `policy`, stricter value wins per field. Runs
    unconditionally after `_resolve_policy` determines the base policy,
    whether that came from an explicit request body or a Module 02 pull -
    ADR-0059 Decision 2's "explicit wins outright, no merge" governs which
    policy *source* to use, not whether the legal floor still applies once
    one is chosen (it always does).

    Fails closed via `_call_upstream`, same as every other gRPC pull in
    this function: a solve job that cannot confirm its policy meets the
    legal floor must not silently proceed with an unverified one. Skipped
    (with a warning, not a failure) only when no jurisdiction is resolvable
    at all for this org unit - the same disclosed country-level-only
    precision limit ADR-0101 accepted for Module 02's own write-time gate.
    """
    country_code = await _call_upstream(
        "CalendarService",
        "GetWorkingTimeRules",
        calendar_client.get_org_unit_country_code(
            get_core_channel(), tenant_id=tenant_id, org_unit_id=org_unit_id, as_of=as_of
        ),
    )
    if country_code is None:
        logger.warning(
            "No jurisdiction resolvable for org_unit_id=%s (tenant_id=%s) - "
            "compliance floor not merged into this solve's policy.",
            org_unit_id,
            tenant_id,
        )
        return policy

    async def _floor(rule_type: str) -> dict[str, object]:
        definition = await _call_upstream(
            "ComplianceRuleService",
            "GetActiveRule",
            compliance_client.get_active_rule_definition(
                get_compliance_channel(),
                tenant_id=tenant_id,
                jurisdiction=country_code,
                rule_type=rule_type,
                as_of=as_of,
            ),
        )
        return definition or {}

    rest_floor = await _floor("rest_period_minimum")
    max_days_floor = await _floor("max_consecutive_days")
    union_floor = await _floor("union_rule")

    min_rest = _stricter_higher(
        policy.min_rest_hours_between_shifts, rest_floor.get("minRestHoursBetweenShifts")
    )
    max_days = _stricter_lower(
        float(policy.max_consecutive_working_days), max_days_floor.get("maxConsecutiveWorkingDays")
    )
    min_shift = _stricter_higher(
        float(policy.min_shift_length_minutes), union_floor.get("minShiftLengthMinutes")
    )
    max_shift = _stricter_lower(
        float(policy.max_shift_length_minutes) if policy.max_shift_length_minutes is not None else None,
        union_floor.get("maxShiftLengthMinutes"),
    )
    break_after = _stricter_lower(
        policy.mandatory_break_after_hours, union_floor.get("mandatoryBreakAfterHours")
    )
    break_minutes = _stricter_higher(
        float(policy.mandatory_break_minutes) if policy.mandatory_break_minutes is not None else None,
        union_floor.get("mandatoryBreakMinutes"),
    )

    return EmploymentPolicy(
        max_consecutive_working_days=int(max_days)
        if max_days is not None
        else policy.max_consecutive_working_days,
        min_rest_hours_between_shifts=min_rest
        if min_rest is not None
        else policy.min_rest_hours_between_shifts,
        min_shift_length_minutes=int(min_shift) if min_shift is not None else policy.min_shift_length_minutes,
        max_shift_length_minutes=int(max_shift) if max_shift is not None else None,
        mandatory_break_after_hours=break_after,
        mandatory_break_minutes=int(break_minutes) if break_minutes is not None else None,
    )


async def _resolve_shifts(body: ScheduleJobRequest, *, tenant_id: uuid.UUID) -> tuple[ShiftSlot, ...]:
    needs_derivation = [s for s in body.shift_slots if s.required_headcount is None]
    requirements = None
    if needs_derivation:
        requirements = await _call_upstream(
            "ForecastService",
            "GetForecastRequirements",
            forecast_client.get_forecast_requirements(
                get_forecasting_channel(), tenant_id=tenant_id, forecast_run_id=body.forecast_run_id
            ),
        )
        if requirements is None:
            raise ShiftHeadcountUndeterminedError(
                str(needs_derivation[0].id),
                f"forecast run '{body.forecast_run_id}' was not found or is not completed",
            )

    def _headcount(shift: ShiftSlotInput) -> int:
        if shift.required_headcount is not None:
            return shift.required_headcount
        assert requirements is not None
        derived = forecast_client.derive_required_headcount(
            requirements, shift_start=shift.start, shift_end=shift.end
        )
        if derived is None:
            raise ShiftHeadcountUndeterminedError(
                str(shift.id), "no overlapping forecast interval has a computed required headcount"
            )
        return derived

    return tuple(
        ShiftSlot(
            id=s.id,
            start=s.start,
            end=s.end,
            required_headcount=_headcount(s),
            required_skill_id=s.required_skill_id,
            break_minutes=s.break_minutes,
            org_unit_id=s.org_unit_id,
        )
        for s in body.shift_slots
    )


async def _resolve_leave_records(
    body: ScheduleJobRequest, *, tenant_id: uuid.UUID, employees: tuple[Employee, ...]
) -> tuple[LeaveRecord, ...]:
    """Module 06 Phase 5/ADR-0078: same optional-field-triggers-pull shape
    as `_resolve_roster`/`_resolve_policy` (ADR-0059 Decision 2) - an
    explicit `leaveRecords` in the request wins outright, no merge; omitted
    (`None`) pulls every approved leave record for this solve's own roster
    and date range from `LeaveService.GetUnavailability`. Scoped to
    `employees` (this solve's already-resolved roster), not a separate
    employee-id list - there's no reason to ask about an employee who isn't
    even a candidate for this solve."""
    if body.leave_records is not None:
        return tuple(solve_input_conversion.to_leave_record(lr) for lr in body.leave_records)
    return await _call_upstream(
        "LeaveService",
        "GetUnavailability",
        leave_client.get_unavailability(
            get_attendance_channel(),
            tenant_id=tenant_id,
            employee_ids=tuple(e.id for e in employees),
            date_range_start=body.date_range.start,
            date_range_end=body.date_range.end,
        ),
    )


async def resolve_submit_solve_input(
    body: ScheduleJobRequest, *, session: AsyncSession, tenant_id: uuid.UUID
) -> SolveInput | None:
    """`shiftSlots` empty gets Phase 1's original behavior (nothing to
    solve) - `None`, meaning the caller should leave the job at `queued`
    forever rather than attempt a solve. Otherwise `policy`/`roster`/each
    shift's `requiredHeadcount`/`leaveRecords` are each resolved
    independently: an explicit value in the request always wins, an
    omitted one is pulled via gRPC (ADR-0059/ADR-0078) - see
    `_resolve_policy`/`_resolve_roster`/`_resolve_shifts`/
    `_resolve_leave_records`.

    When §3.3's fairness bound is configured
    (`body.constraint_config.fairness` is set), this is also where the
    `FairnessLedger` gets queried (`fairness_service.
    get_historical_undesirable_counts`) - the solver itself (`app/solver/`)
    has no DB access of its own, by design (ADR-0055/the module's own
    pure-engine split)."""
    if not body.shift_slots:
        return None

    employees = await _resolve_roster(body, tenant_id=tenant_id)
    policy = await _resolve_policy(body, tenant_id=tenant_id)
    shifts = await _resolve_shifts(body, tenant_id=tenant_id)
    leave_records = await _resolve_leave_records(body, tenant_id=tenant_id, employees=employees)

    fairness_input = body.constraint_config.fairness
    fairness: FairnessConfig | None = None
    fairness_history_counts: dict[uuid.UUID, int] = {}
    if fairness_input is not None:
        fairness = solve_input_conversion.to_fairness_config(fairness_input)
        window_start = body.date_range.start - timedelta(weeks=fairness_input.rolling_period_weeks)
        fairness_history_counts = await fairness_service.get_historical_undesirable_counts(
            session,
            tenant_id=tenant_id,
            employee_ids=[e.id for e in employees],
            window_start=window_start,
            window_end=body.date_range.start,
        )

    return SolveInput(
        date_range_start=body.date_range.start,
        date_range_end=body.date_range.end,
        employees=employees,
        shifts=shifts,
        policy=policy,
        leave_records=leave_records,
        fairness=fairness,
        soft_weights=solve_input_conversion.to_soft_weights(body.constraint_config.soft_weights),
        fairness_history_counts=fairness_history_counts,
    )
