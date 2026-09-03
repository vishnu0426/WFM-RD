"""Phase 6 (ADR-0059): `agno.forecasting.v1.ForecastService`, this service's
first gRPC surface. Tenant context has no HTTP middleware to bind it here
(same posture as Module 01/02's own gRPC controllers, ADR-0021) - bound
explicitly from the request message's own `tenant_id` field, reusing
`app/db/session.py`'s `tenant_scoped_session` exactly as every REST handler
already does.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastDataPoint, ForecastRun
from app.db.session import tenant_scoped_session
from app.grpc.generated import forecast_pb2, forecast_pb2_grpc


def _format_headcount(value: Decimal | None) -> str:
    # Absent (empty string), not "0" - a NULL required_headcount means "could
    # not be computed" (headcount_service.compute_required_headcount's own
    # distinction), never "zero people needed."
    return "" if value is None else str(value)


class ForecastServicer(forecast_pb2_grpc.ForecastServiceServicer):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._session_factory = session_factory

    async def GetForecastRequirements(  # noqa: N802 - grpc-generated method name
        self, request: forecast_pb2.GetForecastRequirementsRequest, context: object
    ) -> forecast_pb2.GetForecastRequirementsResponse:
        try:
            tenant_id = uuid.UUID(request.tenant_id)
            forecast_run_id = uuid.UUID(request.forecast_run_id)
        except ValueError:
            return forecast_pb2.GetForecastRequirementsResponse(found=False)

        tenant_context = TenantContext(tenant_id=str(tenant_id))
        async with tenant_scoped_session(tenant_context, session_factory=self._session_factory) as session:
            run = await session.scalar(
                select(ForecastRun).where(
                    ForecastRun.tenant_id == tenant_id,
                    ForecastRun.id == forecast_run_id,
                    ForecastRun.status == "completed",
                )
            )
            if run is None:
                return forecast_pb2.GetForecastRequirementsResponse(found=False)

            points = (
                await session.scalars(
                    select(ForecastDataPoint)
                    .where(
                        ForecastDataPoint.tenant_id == tenant_id,
                        ForecastDataPoint.forecast_run_id == forecast_run_id,
                    )
                    .order_by(ForecastDataPoint.interval_start)
                )
            ).all()

        return forecast_pb2.GetForecastRequirementsResponse(
            found=True,
            requirements=[
                forecast_pb2.ForecastRequirement(
                    interval_start=point.interval_start.isoformat(),
                    interval_minutes=run.interval_minutes,
                    required_headcount=_format_headcount(point.required_headcount),
                )
                for point in points
            ],
        )
