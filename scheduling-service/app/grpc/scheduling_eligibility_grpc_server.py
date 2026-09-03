"""`agno.scheduling.v1.SchedulingEligibilityService` (docs/adr/0082) - this
service's first gRPC server. Tenant context has no HTTP middleware to bind
it here (same posture as forecasting-service's `ForecastServicer`, ADR-0059)
- bound explicitly from the request message's own `tenant_id` field, reusing
`app/db/session.py`'s `tenant_scoped_session` exactly as every REST handler
and `ForecastServicer` already do.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ShiftAssignment
from app.db.session import tenant_scoped_session
from app.grpc.generated import scheduling_eligibility_pb2, scheduling_eligibility_pb2_grpc
from app.grpc_clients import employee_client, leave_client, policy_client
from app.grpc_clients.channels import get_attendance_channel, get_core_channel
from app.services.schedule_service import list_employee_shift_assignments
from app.solver.eligibility import evaluate_assignment_eligibility
from app.solver.types import ShiftSlot

# Wide enough to comfortably cover any realistic `max_consecutive_working_days`
# window and a full ISO week on either side of the candidate shift - see
# `app/solver/eligibility.py`'s own docstring for why the window just needs
# to be "wide enough," not exact.
_CONTEXT_WINDOW = timedelta(days=14)


class SchedulingEligibilityServicer(
    scheduling_eligibility_pb2_grpc.SchedulingEligibilityServiceServicer
):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._session_factory = session_factory

    async def CheckAssignmentEligibility(  # noqa: N802 - grpc-generated method name
        self,
        request: scheduling_eligibility_pb2.CheckAssignmentEligibilityRequest,
        context: object,
    ) -> scheduling_eligibility_pb2.CheckAssignmentEligibilityResponse:
        try:
            tenant_id = uuid.UUID(request.tenant_id)
            candidate_employee_id = uuid.UUID(request.candidate_employee_id)
            shift_assignment_id = uuid.UUID(request.shift_assignment_id)
            org_unit_id = uuid.UUID(request.org_unit_id)
            exclude_shift_assignment_id = (
                uuid.UUID(request.exclude_shift_assignment_id)
                if request.exclude_shift_assignment_id
                else None
            )
        except ValueError:
            return scheduling_eligibility_pb2.CheckAssignmentEligibilityResponse(
                shift_assignment_found=False, eligible=False
            )

        tenant_context = TenantContext(tenant_id=str(tenant_id))
        async with tenant_scoped_session(tenant_context, session_factory=self._session_factory) as session:
            target = await session.scalar(
                select(ShiftAssignment).where(
                    ShiftAssignment.tenant_id == tenant_id,
                    ShiftAssignment.id == shift_assignment_id,
                )
            )
            if target is None:
                return scheduling_eligibility_pb2.CheckAssignmentEligibilityResponse(
                    shift_assignment_found=False, eligible=False
                )

            existing_rows = await list_employee_shift_assignments(
                session,
                tenant_id=tenant_id,
                employee_id=candidate_employee_id,
                window_start=target.shift_start - _CONTEXT_WINDOW,
                window_end=target.shift_end + _CONTEXT_WINDOW,
            )

        candidate_shift = ShiftSlot(
            id=target.id,
            start=target.shift_start,
            end=target.shift_end,
            required_headcount=1,
            required_skill_id=target.skill_id,
        )
        existing_shifts = tuple(
            ShiftSlot(
                id=assignment.id,
                start=assignment.shift_start,
                end=assignment.shift_end,
                required_headcount=1,
                required_skill_id=assignment.skill_id,
            )
            for assignment, _schedule in existing_rows
            if assignment.id != exclude_shift_assignment_id
        )

        core_channel = get_core_channel()
        attendance_channel = get_attendance_channel()
        roster = await employee_client.get_schedulable_roster(
            core_channel, tenant_id=tenant_id, org_unit_id=org_unit_id
        )
        candidate = next((e for e in roster if e.id == candidate_employee_id), None)
        if candidate is None:
            # Not on this org unit's schedulable roster at all (terminated,
            # wrong org unit, etc.) - a hard "no", not a soft/empty result,
            # so surface it the same shape as any other violation rather than
            # a generic found=False (the shift itself was real).
            return scheduling_eligibility_pb2.CheckAssignmentEligibilityResponse(
                shift_assignment_found=True,
                eligible=False,
                violations=[
                    scheduling_eligibility_pb2.EligibilityViolation(
                        category="skill",
                        detail=f"employee {candidate_employee_id} is not on org unit "
                        f"{org_unit_id}'s schedulable roster",
                    )
                ],
            )

        policy = await policy_client.get_active_employment_policy(
            core_channel, tenant_id=tenant_id, org_unit_id=org_unit_id, as_of=target.shift_start.date()
        )
        leave_records = await leave_client.get_unavailability(
            attendance_channel,
            tenant_id=tenant_id,
            employee_ids=(candidate_employee_id,),
            date_range_start=(target.shift_start - _CONTEXT_WINDOW).date(),
            date_range_end=(target.shift_end + _CONTEXT_WINDOW).date(),
        )

        violations = evaluate_assignment_eligibility(
            candidate=candidate,
            candidate_shift=candidate_shift,
            existing_shifts=existing_shifts,
            leave_records=leave_records,
            policy=policy,
        )
        return scheduling_eligibility_pb2.CheckAssignmentEligibilityResponse(
            shift_assignment_found=True,
            eligible=not violations,
            violations=[
                scheduling_eligibility_pb2.EligibilityViolation(category=v.category, detail=v.detail)
                for v in violations
            ],
        )
