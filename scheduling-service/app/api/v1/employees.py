"""Module 05 Phase 2 (§2.2 rule 2, docs/adr/0064): the one read endpoint this
service exposes for another service to query - added post-hoc because
nothing in Module 04's original 8 phases needed to answer "what is this
employee scheduled to do." Every other assignment-returning endpoint in this
service is scoped by `schedule_id`/`job_id`, which a caller here doesn't
already know."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import EmployeeShiftAssignmentResponse
from app.core.tenant_context import TenantContext
from app.services import schedule_service

router = APIRouter(prefix="/v1/scheduling/employees", tags=["scheduling-employees"])


@router.get("/{employee_id}/shift-assignments", response_model=list[EmployeeShiftAssignmentResponse])
async def list_employee_shift_assignments(
    employee_id: uuid.UUID,
    window_start: datetime = Query(alias="from"),
    window_end: datetime = Query(alias="to"),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[EmployeeShiftAssignmentResponse]:
    rows = await schedule_service.list_employee_shift_assignments(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        employee_id=employee_id,
        window_start=window_start,
        window_end=window_end,
    )
    responses = []
    for assignment, schedule in rows:
        # `schedule_service.list_employee_shift_assignments` already filters
        # `Schedule.status == "published"` - `published_at` is set in the
        # same call (`publish_schedule`) that flips `status`, so it's never
        # `None` here even though the column itself is nullable pre-publish.
        assert schedule.published_at is not None
        responses.append(
            EmployeeShiftAssignmentResponse(
                id=assignment.id,
                employee_id=assignment.employee_id,
                schedule_id=assignment.schedule_id,
                shift_start=assignment.shift_start,
                shift_end=assignment.shift_end,
                skill_id=assignment.skill_id,
                assignment_source=assignment.assignment_source,
                is_overtime=assignment.is_overtime,
                locked=assignment.locked,
                published_at=schedule.published_at,
            )
        )
    return responses
