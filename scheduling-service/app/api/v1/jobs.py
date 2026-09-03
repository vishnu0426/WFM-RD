"""§4.1's submit/poll job contract:
`POST /v1/scheduling/jobs` and `GET /v1/scheduling/jobs/{jobId}`, plus a
Phase 2 addition, `GET /v1/scheduling/jobs/{jobId}/schedule`, to read back
what the solver produced (§4.2's `Schedule`/`ShiftAssignment` GraphQL types
are Node's surface to build later - this is the minimal REST readback this
service needs for its own integration tests and any interim caller before
that GraphQL surface exists).

Phase 7 (ADR-0060): `submit_schedule_job`/`approve_schedule_job_relaxation`
only ever enqueue now - they persist a `queued` row and return immediately.
No gRPC pull and no CP-SAT call ever runs on this request thread; `POST`'s
own response `status` is genuinely `queued`, not a terminal outcome. A
caller polls `GET /{jobId}` until `status` reaches a terminal value -
`app/worker.py` is what actually solves.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_idempotency_key, get_tenant_context
from app.api.v1.schemas import (
    DateRange,
    ScheduleExplanationResponse,
    ScheduleJobDetail,
    ScheduleJobRequest,
    ScheduleJobResponse,
    ScheduleResponse,
    ShiftAssignmentResponse,
    SubmitExplanationRequest,
)
from app.core.tenant_context import TenantContext
from app.db.models import ScheduleExplanation, ScheduleJob
from app.services import explanation_service, job_service

router = APIRouter(prefix="/v1/scheduling/jobs", tags=["scheduling-jobs"])


@router.post("", response_model=ScheduleJobResponse)
async def submit_schedule_job(
    body: ScheduleJobRequest,
    response: Response,
    idempotency_key: str = Depends(get_idempotency_key),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleJobResponse:
    tenant_id = uuid.UUID(context.tenant_id)
    # `shiftSlots` empty -> `None` payload -> Phase 1's original "parked at
    # queued forever" behavior (`job_service.enqueue_submit_job`'s own
    # docstring). Otherwise the full request body rides along as
    # `request_payload` - `app.worker` re-parses it and does the gRPC pulls
    # (ADR-0059) at solve time, not here.
    request_payload = body.model_dump(mode="json", by_alias=True) if body.shift_slots else None
    job, created = await job_service.enqueue_submit_job(
        session,
        tenant_id=tenant_id,
        org_unit_id=body.org_unit_id,
        forecast_run_id=body.forecast_run_id,
        date_range_start=body.date_range.start,
        date_range_end=body.date_range.end,
        constraint_config=body.constraint_config.model_dump(mode="json", by_alias=True),
        idempotency_key=idempotency_key,
        requested_by=uuid.UUID(context.actor_id) if context.actor_id else None,
        request_payload=request_payload,
    )
    response.status_code = 201 if created else 200
    return ScheduleJobResponse(job_id=job.id, status=job.status)


def _to_explanation_response(explanation: ScheduleExplanation | None) -> ScheduleExplanationResponse | None:
    if explanation is None:
        return None
    return ScheduleExplanationResponse(
        id=explanation.id,
        summary_text=explanation.summary_text,
        top_constraints=explanation.top_constraints_json,
        trade_offs=explanation.trade_offs_json,
        generated_by_model_id=explanation.generated_by_model_id,
        created_at=explanation.created_at,
        updated_at=explanation.updated_at,
    )


def _to_job_detail(job: ScheduleJob, explanation: ScheduleExplanation | None = None) -> ScheduleJobDetail:
    return ScheduleJobDetail(
        id=job.id,
        tenant_id=job.tenant_id,
        org_unit_id=job.org_unit_id,
        forecast_run_id=job.forecast_run_id,
        date_range=DateRange(start=job.date_range_start, end=job.date_range_end),
        status=job.status,
        constraint_config=job.constraint_config,
        requested_by=job.requested_by,
        solve_duration_ms=job.solve_duration_ms,
        objective_score=job.objective_score,
        decomposition_plan=job.decomposition_plan,
        relaxations_applied=job.relaxations_applied,
        requested_at=job.requested_at,
        completed_at=job.completed_at,
        explanation=_to_explanation_response(explanation),
    )


@router.get("", response_model=list[ScheduleJobDetail])
async def list_schedule_jobs(
    org_unit_id: uuid.UUID = Query(...),
    limit: int = Query(default=20, gt=0, le=100),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ScheduleJobDetail]:
    tenant_id = uuid.UUID(context.tenant_id)
    jobs = await job_service.list_jobs(session, tenant_id=tenant_id, org_unit_id=org_unit_id, limit=limit)
    return [_to_job_detail(job) for job in jobs]


@router.get("/{job_id}", response_model=ScheduleJobDetail)
async def get_schedule_job(
    job_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleJobDetail:
    tenant_id = uuid.UUID(context.tenant_id)
    job = await job_service.get_job(session, tenant_id=tenant_id, job_id=job_id)
    explanation = await explanation_service.get_explanation(session, tenant_id=tenant_id, job_id=job_id)
    return _to_job_detail(job, explanation)


@router.post("/{job_id}/explanation", response_model=ScheduleJobDetail)
async def submit_schedule_job_explanation(
    job_id: uuid.UUID,
    body: SubmitExplanationRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleJobDetail:
    """Phase 6/ADR-0059's handoff endpoint - Module 10 calls this after
    generating an explanation off `agno.scheduling.job.completed.v1`
    (`job_service.execute_job`'s own publish, wired for real this phase).
    This service only stores the result (§1's mandated-stack table: "Module
    04 requests it, doesn't own the LLM call") - upserts, so a resubmission
    for the same job replaces rather than duplicates."""
    tenant_id = uuid.UUID(context.tenant_id)
    await explanation_service.submit_explanation(
        session,
        tenant_id=tenant_id,
        job_id=job_id,
        summary_text=body.summary_text,
        top_constraints=body.top_constraints,
        trade_offs=body.trade_offs,
        generated_by_model_id=body.generated_by_model_id,
    )
    job = await job_service.get_job(session, tenant_id=tenant_id, job_id=job_id)
    explanation = await explanation_service.get_explanation(session, tenant_id=tenant_id, job_id=job_id)
    return _to_job_detail(job, explanation)


@router.post("/{job_id}/relaxation/approve", response_model=ScheduleJobDetail)
async def approve_schedule_job_relaxation(
    job_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleJobDetail:
    """§5 point 4's human-approval gate as a real endpoint: flips a
    recorded, feasible relaxation option (see `GET /{jobId}`'s
    `relaxationsApplied`) back to `queued` for `app.worker` to re-solve. No
    request body - approves exactly the relaxation categories the search
    already found and reported, never a different set (see
    `job_service.enqueue_relaxation_approval`'s docstring for why). Returns
    immediately with `status: queued`/`solving` - poll `GET /{jobId}` for
    the outcome, same as every other job."""
    job = await job_service.enqueue_relaxation_approval(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        job_id=job_id,
        approved_by=uuid.UUID(context.actor_id) if context.actor_id else None,
    )
    return _to_job_detail(job)


@router.get("/{job_id}/schedule", response_model=ScheduleResponse)
async def get_schedule_job_schedule(
    job_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduleResponse:
    schedule, assignments = await job_service.get_schedule_with_assignments(
        session, tenant_id=uuid.UUID(context.tenant_id), job_id=job_id
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
