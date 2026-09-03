"""`agno.scheduling.v1.ScheduleQueryService` (docs/adr/0103) - bulk read
side of `schedule_service.list_shift_assignments_for_employees`. Same
"bind tenant context from the request message, no HTTP middleware" posture
as `SchedulingEligibilityServicer`.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.session import tenant_scoped_session
from app.grpc.generated import schedule_query_pb2, schedule_query_pb2_grpc
from app.services.schedule_service import list_shift_assignments_for_employees


class ScheduleQueryServicer(schedule_query_pb2_grpc.ScheduleQueryServiceServicer):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._session_factory = session_factory

    async def ListPublishedShiftAssignments(  # noqa: N802 - grpc-generated method name
        self,
        request: schedule_query_pb2.ListPublishedShiftAssignmentsRequest,
        context: object,
    ) -> AsyncIterator[schedule_query_pb2.ShiftAssignmentRecord]:
        try:
            tenant_id = uuid.UUID(request.tenant_id)
            employee_ids = [uuid.UUID(e) for e in request.employee_ids]
            window_start = datetime.fromisoformat(request.window_start)
            window_end = datetime.fromisoformat(request.window_end)
        except ValueError:
            # Malformed request: an empty stream, not a thrown error - the
            # caller (Module 08) treats zero rows for zero valid employees
            # identically to zero rows for a genuinely empty roster.
            return

        tenant_context = TenantContext(tenant_id=str(tenant_id))
        async with tenant_scoped_session(tenant_context, session_factory=self._session_factory) as session:
            rows = await list_shift_assignments_for_employees(
                session,
                tenant_id=tenant_id,
                employee_ids=employee_ids,
                window_start=window_start,
                window_end=window_end,
            )

        for assignment, schedule in rows:
            yield schedule_query_pb2.ShiftAssignmentRecord(
                employee_id=str(assignment.employee_id),
                schedule_id=str(schedule.id),
                shift_start=assignment.shift_start.isoformat(),
                shift_end=assignment.shift_end.isoformat(),
                is_overtime=assignment.is_overtime,
            )
