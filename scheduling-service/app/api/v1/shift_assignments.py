"""Bulk-by-employee-ids counterpart to `app/api/v1/employees.py`'s
`GET /v1/scheduling/employees/{employee_id}/shift-assignments` — the roster
board (web-console's Employees > Roster tab) needs one org unit's whole
employee list's assignments for a week in one round trip, not one request
per employee. Wraps the existing `schedule_service.list_shift_assignments_for_employees`,
already used internally by Module 08's rule-impact simulation via gRPC —
this is the same query, just newly reachable over REST. This service has no
employee data of its own (§2.2 rule 2): the caller (web-console) resolves
which employee ids belong to the org unit via the root service's GraphQL
`employees(filter: {orgUnitId})` and passes the ids here directly, so no
org-unit-aware query needed on this side at all.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import EmployeeShiftAssignmentResponse
from app.core.tenant_context import TenantContext
from app.services import schedule_service

router = APIRouter(prefix="/v1/scheduling/shift-assignments", tags=["scheduling-shift-assignments"])


@router.get("", response_model=list[EmployeeShiftAssignmentResponse])
async def list_shift_assignments(
    # Defaults to `[]` rather than being required — an org unit with no
    # employees (or none yet resolved client-side) is a real,
    # unexceptional case, same posture `list_shift_assignments_for_employees`
    # itself already takes ("empty employee_ids returns [] without
    # querying").
    employee_ids: list[uuid.UUID] = Query(default_factory=list, alias="employeeIds"),
    window_start: datetime = Query(alias="from"),
    window_end: datetime = Query(alias="to"),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[EmployeeShiftAssignmentResponse]:
    rows = await schedule_service.list_shift_assignments_for_employees(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        employee_ids=employee_ids,
        window_start=window_start,
        window_end=window_end,
    )
    responses = []
    for assignment, schedule in rows:
        # Same invariant `list_employee_shift_assignments`'s handler relies
        # on: only `status: published` schedules are ever returned, and
        # `published_at` is set in the same call that flips `status`.
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
