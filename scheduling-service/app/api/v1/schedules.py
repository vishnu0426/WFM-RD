"""Phase 3's schedule-scoped endpoints: publishing (the §3.3 `FairnessLedger`
refresh trigger, `Schedule.published_at`) and the compliance-auditor
fairness query the module prompt asks for by name.

Phase 7 (ADR-0060): `reoptimize_schedule` only enqueues now - see
`app/api/v1/jobs.py`'s own module docstring for why."""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from nats.js import JetStreamContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_idempotency_key, get_jetstream, get_tenant_context
from app.api.v1.schemas import (
    FairnessAuditEmployeeEntry,
    FairnessAuditResponse,
    OverrideAssignmentRequest,
    ReoptimizeScheduleRequest,
    ResolveScheduleConflictRequest,
    ScheduleConflictResponse,
    ScheduleJobResponse,
    ScheduleResponse,
    ShiftAssignmentResponse,
)
from app.core.tenant_context import TenantContext
from app.services import job_service, schedule_service

router = APIRouter(prefix="/v1/scheduling", tags=["scheduling-schedules"])


@router.post("/schedules/{schedule_id}/publish", response_model=ScheduleResponse)
async def publish_schedule(
    schedule_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
    js: JetStreamContext = Depends(get_jetstream),
) -> ScheduleResponse:
    schedule, assignments = await schedule_service.publish_schedule(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        schedule_id=schedule_id,
        published_by=uuid.UUID(context.actor_id) if context.actor_id else None,
        js=js,
    )
    return ScheduleResponse(
        id=schedule.id,
        schedule_job_id=schedule.schedule_job_id,
        status=schedule.status,
        published_at=schedule.published_at,
        published_by=schedule.published_by,
        assignments=[
            ShiftAssignmentResponse(
                id=a.id,
                employee_id=a.employee_id,
                shift_start=a.shift_start,
                shift_end=a.shift_end,
                skill_id=a.skill_id,
                assignment_source=a.assignment_source,
                is_overtime=a.is_overtime,
                locked=a.locked,
            )
            for a in assignments
        ],
    )


@router.post(
    "/schedules/{schedule_id}/assignments/{assignment_id}/override", response_model=ShiftAssignmentResponse
)
async def override_assignment(
    schedule_id: uuid.UUID,
    assignment_id: uuid.UUID,
    body: OverrideAssignmentRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
    js: JetStreamContext = Depends(get_jetstream),
) -> ShiftAssignmentResponse:
    """§4.2's `overrideAssignment` mutation, this service's REST equivalent
    (see `schedule_service.override_assignment`'s docstring for the full
    behavior, including the `double_booking` conflict check)."""
    assignment = await schedule_service.override_assignment(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        schedule_id=schedule_id,
        assignment_id=assignment_id,
        new_employee_id=body.employee_id,
        js=js,
    )
    return ShiftAssignmentResponse(
        id=assignment.id,
        employee_id=assignment.employee_id,
        shift_start=assignment.shift_start,
        shift_end=assignment.shift_end,
        skill_id=assignment.skill_id,
        assignment_source=assignment.assignment_source,
        is_overtime=assignment.is_overtime,
        locked=assignment.locked,
    )


@router.post("/schedules/{schedule_id}/reoptimize", response_model=ScheduleJobResponse)
async def reoptimize_schedule(
    schedule_id: uuid.UUID,
    body: ReoptimizeScheduleRequest,
    response: Response,
    idempotency_key: str = Depends(get_idempotency_key),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleJobResponse:
    """Phase 5's re-optimization entry point (§2.2 rule 1), Phase 7-async'd
    (ADR-0060) - see `job_service.enqueue_reoptimize`'s docstring for what's
    validated here vs. deferred to `app.worker`. Returns the same
    `{ jobId, status }` shape as `POST /v1/scheduling/jobs` (a
    re-optimization is a new solve, tracked as its own `ScheduleJob`), 201
    on first submission, 200 on an `Idempotency-Key` replay - `status` is
    `queued`, not a terminal outcome; poll `GET /v1/scheduling/jobs/{jobId}`."""
    tenant_id = uuid.UUID(context.tenant_id)
    job, created = await job_service.enqueue_reoptimize(
        session,
        tenant_id=tenant_id,
        schedule_id=schedule_id,
        request_payload=body.model_dump(mode="json", by_alias=True),
        constraint_config=body.constraint_config.model_dump(mode="json", by_alias=True),
        idempotency_key=idempotency_key,
        requested_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    response.status_code = 201 if created else 200
    return ScheduleJobResponse(job_id=job.id, status=job.status)


@router.get("/schedules/{schedule_id}/conflicts", response_model=list[ScheduleConflictResponse])
async def list_schedule_conflicts(
    schedule_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ScheduleConflictResponse]:
    conflicts = await schedule_service.list_conflicts(
        session, tenant_id=uuid.UUID(context.tenant_id), schedule_id=schedule_id
    )
    return [
        ScheduleConflictResponse(
            id=c.id,
            conflict_type=c.conflict_type,
            affected_employee_id=c.affected_employee_id,
            status=c.status,
            suggested_resolution=c.suggested_resolution_json,
            created_at=c.created_at,
        )
        for c in conflicts
    ]


@router.post("/schedules/{schedule_id}/conflicts/{conflict_id}/resolve", response_model=ScheduleConflictResponse)
async def resolve_schedule_conflict(
    schedule_id: uuid.UUID,
    conflict_id: uuid.UUID,
    body: ResolveScheduleConflictRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleConflictResponse:
    conflict = await schedule_service.resolve_conflict(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        schedule_id=schedule_id,
        conflict_id=conflict_id,
        status=body.status,
    )
    return ScheduleConflictResponse(
        id=conflict.id,
        conflict_type=conflict.conflict_type,
        affected_employee_id=conflict.affected_employee_id,
        status=conflict.status,
        suggested_resolution=conflict.suggested_resolution_json,
        created_at=conflict.created_at,
    )


@router.get("/fairness/audit", response_model=FairnessAuditResponse)
async def fairness_audit(
    period_start: date = Query(alias="periodStart"),
    period_end: date = Query(alias="periodEnd"),
    tolerance: int = Query(),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> FairnessAuditResponse:
    counts, average = await schedule_service.audit_fairness(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        period_start=period_start,
        period_end=period_end,
        tolerance=tolerance,
    )
    return FairnessAuditResponse(
        period_start=period_start,
        period_end=period_end,
        tolerance=tolerance,
        average_undesirable_shift_count=average,
        employees=[
            FairnessAuditEmployeeEntry(
                employee_id=employee_id,
                undesirable_shift_count=count,
                exceeded_tolerance=schedule_service.exceeds_tolerance(count, average, tolerance),
            )
            for employee_id, count in counts.items()
        ],
    )
