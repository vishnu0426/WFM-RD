"""`agno.scheduling.v1.ScheduleExplanationDataService` (docs/adr/0115) - the
read half of the Module 04<->Module 10 schedule-explanation handoff. Same
"bind tenant context from the request message, no HTTP middleware" posture
as `ScheduleQueryServicer`/`SchedulingEligibilityServicer`.
"""

from __future__ import annotations

import json
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import DomainError
from app.core.tenant_context import TenantContext
from app.db.session import tenant_scoped_session
from app.grpc.generated import schedule_explanation_data_pb2, schedule_explanation_data_pb2_grpc
from app.services.job_service import get_job


class ScheduleExplanationDataServicer(
    schedule_explanation_data_pb2_grpc.ScheduleExplanationDataServiceServicer
):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._session_factory = session_factory

    async def GetScheduleJobForExplanation(  # noqa: N802 - grpc-generated method name
        self,
        request: schedule_explanation_data_pb2.GetScheduleJobForExplanationRequest,
        context: object,
    ) -> schedule_explanation_data_pb2.GetScheduleJobForExplanationResponse:
        try:
            tenant_id = uuid.UUID(request.tenant_id)
            job_id = uuid.UUID(request.job_id)
        except ValueError:
            # Malformed request: found=false, same convention as a
            # not-found/wrong-tenant job - never a thrown gRPC error for a
            # caller-supplied id that simply doesn't parse.
            return schedule_explanation_data_pb2.GetScheduleJobForExplanationResponse(found=False)

        tenant_context = TenantContext(tenant_id=str(tenant_id))
        try:
            async with tenant_scoped_session(
                tenant_context, session_factory=self._session_factory
            ) as session:
                job = await get_job(session, tenant_id=tenant_id, job_id=job_id)
        except DomainError:
            # ScheduleJobNotFoundError - not this tenant's job, or doesn't
            # exist. Same `found: false` treatment as a malformed request.
            return schedule_explanation_data_pb2.GetScheduleJobForExplanationResponse(found=False)

        return schedule_explanation_data_pb2.GetScheduleJobForExplanationResponse(
            found=True,
            tenant_id=str(job.tenant_id),
            status=job.status,
            org_unit_id=str(job.org_unit_id),
            date_range_start=job.date_range_start.isoformat(),
            date_range_end=job.date_range_end.isoformat(),
            objective_score=str(job.objective_score) if job.objective_score is not None else "",
            constraint_config_json=json.dumps(job.constraint_config or {}),
            relaxations_applied_json=json.dumps(job.relaxations_applied) if job.relaxations_applied else "",
            decomposition_plan_json=json.dumps(job.decomposition_plan) if job.decomposition_plan else "",
            completed_at=job.completed_at.isoformat() if job.completed_at else "",
        )
