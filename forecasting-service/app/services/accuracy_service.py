"""§7's `ForecastAccuracyLog` population (ADR-0025) - triggered by actuals
ingestion, not a scheduler, and the staleness/retraining-trigger signal
(`GET /v1/forecasting/models/{orgUnitId}/staleness`).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ForecastAccuracyLog, ForecastDataPoint, ForecastModel, ForecastRun
from app.ml.accuracy import interval_bias, interval_mape
from app.services.historical_actuals_service import ActualPoint

# ADR-0025, Decision 3.
AGE_STALE_THRESHOLD_HOURS = 48
ACCURACY_DEGRADED_MIN_SAMPLES = 10
ACCURACY_DEGRADED_RELATIVE_MARGIN = 0.50


async def log_accuracy_for_new_actuals(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    points: list[ActualPoint],
) -> int:
    """For every newly-ingested actual with a known volume, scores every
    `completed` forecast run's prediction at that same interval that hasn't
    already been scored (ADR-0025, Decision 1). Returns the number of
    `ForecastAccuracyLog` rows written."""
    actual_by_interval = {p.interval_start: p.actual_volume for p in points if p.actual_volume is not None}
    if not actual_by_interval:
        return 0

    candidates = (
        await session.execute(
            select(
                ForecastDataPoint.forecast_run_id,
                ForecastDataPoint.interval_start,
                ForecastDataPoint.predicted_volume,
            )
            .join(ForecastRun, ForecastRun.id == ForecastDataPoint.forecast_run_id)
            .where(
                ForecastDataPoint.tenant_id == tenant_id,
                ForecastRun.tenant_id == tenant_id,
                ForecastRun.org_unit_id == org_unit_id,
                ForecastRun.status == "completed",
                ForecastDataPoint.interval_start.in_(actual_by_interval.keys()),
                ForecastDataPoint.predicted_volume.is_not(None),
            )
        )
    ).all()
    if not candidates:
        return 0

    already_scored = (
        await session.execute(
            select(ForecastAccuracyLog.forecast_run_id, ForecastAccuracyLog.evaluated_at).where(
                ForecastAccuracyLog.tenant_id == tenant_id,
                ForecastAccuracyLog.forecast_run_id.in_({c.forecast_run_id for c in candidates}),
                ForecastAccuracyLog.evaluated_at.in_(actual_by_interval.keys()),
            )
        )
    ).all()
    already_scored_keys = {(row.forecast_run_id, row.evaluated_at) for row in already_scored}

    written = 0
    for candidate in candidates:
        key = (candidate.forecast_run_id, candidate.interval_start)
        if key in already_scored_keys:
            continue

        actual_volume = actual_by_interval[candidate.interval_start]
        predicted_volume = candidate.predicted_volume
        actual_float = float(actual_volume)
        predicted_float = float(predicted_volume)

        session.add(
            ForecastAccuracyLog(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                forecast_run_id=candidate.forecast_run_id,
                org_unit_id=org_unit_id,
                actual_volume=actual_volume,
                predicted_volume=predicted_volume,
                mape=_to_decimal(interval_mape(actual_float, predicted_float)),
                bias=_to_decimal(interval_bias(actual_float, predicted_float)),
                # ADR-0025: the scored interval, not wall-clock "now".
                evaluated_at=candidate.interval_start,
            )
        )
        written += 1
        already_scored_keys.add(key)

    if written:
        await session.flush()
    return written


def _to_decimal(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, 6)))


async def get_accuracy_trend(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> list[ForecastAccuracyLog]:
    """§3.2's `forecastAccuracyTrend(orgUnitId, period)` - `evaluated_at`
    (the scored interval, per Decision 1) ordered ascending so callers get a
    genuine time series, not insertion order."""
    return list(
        (
            await session.execute(
                select(ForecastAccuracyLog)
                .where(
                    ForecastAccuracyLog.tenant_id == tenant_id,
                    ForecastAccuracyLog.org_unit_id == org_unit_id,
                )
                .order_by(ForecastAccuracyLog.evaluated_at.asc())
            )
        )
        .scalars()
        .all()
    )


@dataclass(frozen=True)
class StalenessResult:
    has_active_model: bool
    active_model_id: uuid.UUID | None
    trained_at: datetime | None
    age_hours: float | None
    age_stale: bool | None
    backtest_mape: float | None
    recent_avg_mape: float | None
    sample_size: int
    accuracy_degraded: bool | None
    insufficient_accuracy_data: bool
    retrain_recommended: bool


async def check_staleness(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    target_metric: str = "volume",
    as_of: datetime | None = None,
) -> StalenessResult:
    as_of = as_of or datetime.now(UTC)

    active_model = await session.scalar(
        select(ForecastModel).where(
            ForecastModel.tenant_id == tenant_id,
            ForecastModel.org_unit_id == org_unit_id,
            ForecastModel.target_metric == target_metric,
            ForecastModel.status == "active",
        )
    )
    if active_model is None or active_model.trained_at is None:
        return StalenessResult(
            has_active_model=active_model is not None,
            active_model_id=active_model.id if active_model is not None else None,
            trained_at=None,
            age_hours=None,
            age_stale=None,
            backtest_mape=None,
            recent_avg_mape=None,
            sample_size=0,
            accuracy_degraded=None,
            insufficient_accuracy_data=True,
            retrain_recommended=False,
        )

    age_hours = (as_of - active_model.trained_at).total_seconds() / 3600
    age_stale = age_hours > AGE_STALE_THRESHOLD_HOURS

    recent_logs = (
        await session.execute(
            select(ForecastAccuracyLog.mape)
            .where(
                ForecastAccuracyLog.tenant_id == tenant_id,
                ForecastAccuracyLog.org_unit_id == org_unit_id,
                ForecastAccuracyLog.mape.is_not(None),
            )
            .order_by(ForecastAccuracyLog.evaluated_at.desc())
            .limit(ACCURACY_DEGRADED_MIN_SAMPLES)
        )
    ).scalars().all()

    recent_mape_values = [float(value) for value in recent_logs if value is not None]
    sample_size = len(recent_mape_values)
    insufficient_accuracy_data = sample_size < ACCURACY_DEGRADED_MIN_SAMPLES
    recent_avg_mape = sum(recent_mape_values) / sample_size if sample_size else None
    backtest_mape = float(active_model.backtest_mape) if active_model.backtest_mape is not None else None

    accuracy_degraded: bool | None = None
    if not insufficient_accuracy_data and backtest_mape is not None and recent_avg_mape is not None:
        accuracy_degraded = recent_avg_mape > backtest_mape * (1 + ACCURACY_DEGRADED_RELATIVE_MARGIN)

    retrain_recommended = age_stale or bool(accuracy_degraded)

    return StalenessResult(
        has_active_model=True,
        active_model_id=active_model.id,
        trained_at=active_model.trained_at,
        age_hours=age_hours,
        age_stale=age_stale,
        backtest_mape=backtest_mape,
        recent_avg_mape=recent_avg_mape,
        sample_size=sample_size,
        accuracy_degraded=accuracy_degraded,
        insufficient_accuracy_data=insufficient_accuracy_data,
        retrain_recommended=retrain_recommended,
    )
