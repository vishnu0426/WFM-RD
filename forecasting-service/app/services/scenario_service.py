"""§3.3's `POST /v1/forecasting/scenarios` - `ScenarioSimulation` producing
a real `ForecastRun`, "same read path as live forecasts" (§7). ADR-0024:
arithmetic over an existing base run's `ForecastDataPoint` rows, not a
re-forecast - completes synchronously, no Ray/MLflow involved.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    ScenarioBaseRunEmptyError,
    ScenarioBaseRunNotFoundError,
    ScenarioSimulationNotFoundError,
)
from app.db.models import ForecastDataPoint, ForecastRun, ScenarioSimulation
from app.ml.scenario import AssumptionOverrides, apply_overrides
from app.services import headcount_service


def _to_float(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _to_decimal(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, 4)))


async def create_scenario(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    base_forecast_run_id: uuid.UUID,
    overrides: AssumptionOverrides,
    assumption_overrides_raw: dict[str, object],
) -> tuple[ScenarioSimulation, ForecastRun]:
    """Returns `(scenario, result_run)` - the caller (the route) needs
    `result_run.org_unit_id` to publish the completion event (ADR-0024,
    Decision 4) without an extra round trip."""
    base_run = await session.scalar(
        select(ForecastRun).where(
            ForecastRun.tenant_id == tenant_id, ForecastRun.id == base_forecast_run_id
        )
    )
    if base_run is None:
        raise ScenarioBaseRunNotFoundError(str(base_forecast_run_id))

    base_points = (
        await session.scalars(
            select(ForecastDataPoint)
            .where(
                ForecastDataPoint.tenant_id == tenant_id,
                ForecastDataPoint.forecast_run_id == base_forecast_run_id,
            )
            .order_by(ForecastDataPoint.interval_start)
        )
    ).all()
    if not base_points:
        raise ScenarioBaseRunEmptyError(str(base_forecast_run_id))

    headcount_context = await headcount_service.build_headcount_context(
        session, tenant_id=tenant_id, org_unit_id=base_run.org_unit_id
    )

    now = datetime.now(UTC)
    result_run = ForecastRun(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=base_run.org_unit_id,
        forecast_model_id=base_run.forecast_model_id,
        date_range_start=base_run.date_range_start,
        date_range_end=base_run.date_range_end,
        interval_minutes=base_run.interval_minutes,
        status="completed",
        is_cold_start=base_run.is_cold_start,
        created_by=None,
        requested_at=now,
        completed_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(result_run)
    await session.flush()

    for base_point in base_points:
        # ADR-0024, Decision 2: resolve to the *effective* AHT/shrinkage
        # (own value, or the same historical fallback Phase 5 would use)
        # before applying the override delta - a scenario's whole point is
        # showing what was assumed, not hiding it behind NULL the way a
        # model-fulfilled base run's own columns do.
        effective_aht = _to_float(base_point.predicted_aht_seconds)
        if effective_aht is None:
            effective_aht = headcount_context.fallback_aht_seconds
        effective_shrinkage = _to_float(base_point.predicted_shrinkage_pct)
        if effective_shrinkage is None:
            effective_shrinkage = headcount_context.fallback_shrinkage

        adjusted = apply_overrides(
            volume=_to_float(base_point.predicted_volume),
            aht_seconds=effective_aht,
            shrinkage_pct=effective_shrinkage,
            overrides=overrides,
        )

        volume_multiplier = overrides.volume_multiplier
        base_lower = _to_float(base_point.confidence_lower)
        base_upper = _to_float(base_point.confidence_upper)
        adjusted_lower = None if base_lower is None else base_lower * volume_multiplier
        adjusted_upper = None if base_upper is None else base_upper * volume_multiplier

        required_headcount = headcount_service.compute_required_headcount(
            predicted_volume=adjusted.volume,
            predicted_aht_seconds=adjusted.aht_seconds,
            predicted_shrinkage_pct=adjusted.shrinkage_pct,
            interval_minutes=base_run.interval_minutes,
            context=headcount_context,
        )

        session.add(
            ForecastDataPoint(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                forecast_run_id=result_run.id,
                interval_start=base_point.interval_start,
                predicted_volume=_to_decimal(adjusted.volume),
                predicted_aht_seconds=_to_decimal(adjusted.aht_seconds),
                predicted_shrinkage_pct=_to_decimal(adjusted.shrinkage_pct),
                confidence_lower=_to_decimal(adjusted_lower),
                confidence_upper=_to_decimal(adjusted_upper),
                required_headcount=required_headcount,
                created_at=now,
            )
        )

    scenario = ScenarioSimulation(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        base_forecast_run_id=base_forecast_run_id,
        assumption_overrides=assumption_overrides_raw,
        result_forecast_run_id=result_run.id,
        status="completed",
        created_at=now,
        updated_at=now,
    )
    session.add(scenario)
    await session.flush()
    return scenario, result_run


async def get_scenario(
    session: AsyncSession, *, tenant_id: uuid.UUID, scenario_id: uuid.UUID
) -> ScenarioSimulation:
    scenario = await session.scalar(
        select(ScenarioSimulation).where(
            ScenarioSimulation.tenant_id == tenant_id, ScenarioSimulation.id == scenario_id
        )
    )
    if scenario is None:
        raise ScenarioSimulationNotFoundError(str(scenario_id))
    return scenario
