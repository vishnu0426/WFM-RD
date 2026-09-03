"""`agno.forecasting.v1.ForecastExplanationDataService` (docs/adr/0119) -
the data source for Module 10's `explainForecast(forecastRunId)`. Same
"bind tenant context from the request message, no HTTP middleware" posture
as `ForecastServicer`.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastAccuracyLog, ForecastModel, ForecastRun
from app.db.session import tenant_scoped_session
from app.grpc.generated import forecast_explanation_data_pb2, forecast_explanation_data_pb2_grpc


def _decimal_str(value: Decimal | None) -> str:
    # Empty string for NULL, never "0" - a missing accuracy figure is not
    # the same claim as a measured zero (same convention forecast_grpc_server's
    # own _format_headcount already established).
    return "" if value is None else str(value)


class ForecastExplanationDataServicer(
    forecast_explanation_data_pb2_grpc.ForecastExplanationDataServiceServicer
):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession] | None = None) -> None:
        self._session_factory = session_factory

    async def GetForecastRunForExplanation(  # noqa: N802 - grpc-generated method name
        self,
        request: forecast_explanation_data_pb2.GetForecastRunForExplanationRequest,
        context: object,
    ) -> forecast_explanation_data_pb2.GetForecastRunForExplanationResponse:
        try:
            tenant_id = uuid.UUID(request.tenant_id)
            forecast_run_id = uuid.UUID(request.forecast_run_id)
        except ValueError:
            return forecast_explanation_data_pb2.GetForecastRunForExplanationResponse(found=False)

        tenant_context = TenantContext(tenant_id=str(tenant_id))
        async with tenant_scoped_session(tenant_context, session_factory=self._session_factory) as session:
            run = await session.scalar(
                select(ForecastRun).where(
                    ForecastRun.tenant_id == tenant_id, ForecastRun.id == forecast_run_id
                )
            )
            if run is None:
                return forecast_explanation_data_pb2.GetForecastRunForExplanationResponse(found=False)

            model = None
            if run.forecast_model_id is not None:
                model = await session.scalar(
                    select(ForecastModel).where(
                        ForecastModel.tenant_id == tenant_id, ForecastModel.id == run.forecast_model_id
                    )
                )

            accuracy_rows = (
                await session.scalars(
                    select(ForecastAccuracyLog)
                    .where(
                        ForecastAccuracyLog.tenant_id == tenant_id,
                        ForecastAccuracyLog.forecast_run_id == forecast_run_id,
                    )
                    .order_by(ForecastAccuracyLog.evaluated_at)
                )
            ).all()

        return forecast_explanation_data_pb2.GetForecastRunForExplanationResponse(
            found=True,
            tenant_id=str(run.tenant_id),
            org_unit_id=str(run.org_unit_id),
            status=run.status,
            date_range_start=run.date_range_start.isoformat(),
            date_range_end=run.date_range_end.isoformat(),
            interval_minutes=run.interval_minutes,
            is_cold_start=run.is_cold_start,
            completed_at=run.completed_at.isoformat() if run.completed_at else "",
            has_model=model is not None,
            model_type=model.model_type if model else "",
            model_status=model.status if model else "",
            backtest_mape=_decimal_str(model.backtest_mape) if model else "",
            backtest_wfa=_decimal_str(model.backtest_wfa) if model else "",
            minimum_data_volume_met=model.minimum_data_volume_met if model else False,
            accuracy_log=[
                forecast_explanation_data_pb2.ForecastAccuracyEntry(
                    evaluated_at=row.evaluated_at.isoformat(),
                    actual_volume=_decimal_str(row.actual_volume),
                    predicted_volume=_decimal_str(row.predicted_volume),
                    mape=_decimal_str(row.mape),
                    bias=_decimal_str(row.bias),
                )
                for row in accuracy_rows
            ],
        )
