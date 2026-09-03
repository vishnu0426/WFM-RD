"""Runs a trained `ForecastModel`'s fitted artifact forward over a
`ForecastRun`'s requested date range, writing real `ForecastDataPoint` rows.
Called synchronously from `job_service.create_job` when an `active` model
already exists (ADR-0021, Decision 2) - loading a pickled statsmodels/Prophet
model and calling `.forecast()`/`.predict()` is low-seconds work, not the
minutes-scale cost training is - but it's still blocking, synchronous code
with no `await` of its own, so it runs via `asyncio.to_thread` rather than
freezing the event loop for every other concurrent request during that time.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ForecastDataPoint, ForecastModel
from app.ml.types import PointForecast
from app.services import headcount_service

# ADR-0020/0021's discriminator convention: only `target_metric='volume'`
# has a trained model in this phase, so `predicted_aht_seconds`/
# `predicted_shrinkage_pct` stay NULL on every row this writes -
# `required_headcount` (Phase 5, ADR-0023) still gets computed using the
# historical-average AHT/shrinkage fallback chain, not left NULL too.


def _future_index(date_range_start: date, date_range_end: date, interval_minutes: int) -> pd.DatetimeIndex:
    start = datetime.combine(date_range_start, time.min, tzinfo=UTC)
    end = datetime.combine(date_range_end, time.min, tzinfo=UTC) + timedelta(days=1)
    return pd.date_range(start, end, freq=f"{interval_minutes}min", inclusive="left")


def _to_decimal(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, 4)))


def _load_and_forecast(artifact_uri: str, model_type: str, future_index: pd.DatetimeIndex) -> PointForecast:
    """The blocking part (MLflow artifact download/unpickle + the model's
    own `.forecast()`/`.predict()`) - isolated so `run_inference` can hand
    the whole thing to a worker thread in one call."""
    from app.services import mlflow_registry  # lazy - ADR-0021 Decision 5

    fitted: Any = mlflow_registry.load_model(artifact_uri)

    if model_type == "sarima":
        from app.ml.sarima import forecast_sarima

        forecast = forecast_sarima(fitted, steps=len(future_index))
        forecast.predicted.index = future_index
        forecast.lower.index = future_index
        forecast.upper.index = future_index
        return forecast
    if model_type == "prophet":
        from app.ml.prophet_model import forecast_prophet

        return forecast_prophet(fitted, future_index)
    if model_type == "lightgbm":
        from app.ml.lightgbm_model import forecast_lightgbm

        return forecast_lightgbm(fitted, future_index)
    if model_type == "tft":
        from app.ml.tft import forecast_tft

        # `forecast_tft` extrapolates `steps` points forward from wherever
        # training data ended, same as `forecast_sarima` above - if the
        # caller's requested `future_index` doesn't start right where
        # training left off (a real gap is normal: a model trained today
        # can be asked to forecast a date range starting next week), its
        # own computed index is relabeled to the caller's, exactly
        # mirroring the SARIMA branch's identical simplification.
        forecast = forecast_tft(fitted, steps=len(future_index))
        forecast.predicted.index = future_index
        forecast.lower.index = future_index
        forecast.upper.index = future_index
        return forecast
    raise ValueError(f"no inference path for model_type={model_type!r} in this phase")


async def run_inference(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    forecast_run_id: uuid.UUID,
    model: ForecastModel,
    date_range_start: date,
    date_range_end: date,
    interval_minutes: int,
) -> int:
    future_index = _future_index(date_range_start, date_range_end, interval_minutes)
    assert model.artifact_uri is not None  # active models always have a logged artifact
    forecast = await asyncio.to_thread(
        _load_and_forecast, model.artifact_uri, model.model_type, future_index
    )
    headcount_context = await headcount_service.build_headcount_context(
        session, tenant_id=tenant_id, org_unit_id=model.org_unit_id
    )

    now = datetime.now(UTC)
    created = 0
    for interval_start in future_index:
        predicted_volume = _to_decimal(forecast.predicted.get(interval_start))
        session.add(
            ForecastDataPoint(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                forecast_run_id=forecast_run_id,
                interval_start=interval_start.to_pydatetime(),
                predicted_volume=predicted_volume,
                predicted_aht_seconds=None,
                predicted_shrinkage_pct=None,
                confidence_lower=_to_decimal(forecast.lower.get(interval_start)),
                confidence_upper=_to_decimal(forecast.upper.get(interval_start)),
                required_headcount=headcount_service.compute_required_headcount(
                    predicted_volume=predicted_volume,
                    predicted_aht_seconds=None,
                    predicted_shrinkage_pct=None,
                    interval_minutes=interval_minutes,
                    context=headcount_context,
                ),
                created_at=now,
            )
        )
        created += 1

    await session.flush()
    return created
