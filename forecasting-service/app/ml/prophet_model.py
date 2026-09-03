"""Prophet fit/forecast, thin wrappers matching `sarima.py`'s shape so
`app/ml/training.py` can treat both model types uniformly."""

from __future__ import annotations

from datetime import date

import pandas as pd
from prophet import Prophet

from app.ml.types import PointForecast


def fit_prophet(train: pd.Series, holidays: pd.DataFrame | None = None) -> Prophet:
    """Unlike SARIMAX, Prophet does not accept `NaN` targets - gap rows are
    dropped rather than imputed, since Prophet fits on `(ds, y)` pairs
    directly and doesn't need a regular grid the way a state-space model
    benefits from. Default `interval_width=0.8` matches `sarima.py`'s
    `CONFIDENCE_ALPHA` so the two model types' confidence bands are
    comparable.

    `holidays` is Prophet's native `(holiday, ds, lower_window, upper_window)`
    frame (ADR-0025, Decision 5) - `None` (the default) fits without any
    holiday effect, unchanged from pre-Phase-7 behavior."""
    frame = train.dropna().rename_axis("ds").reset_index(name="y")
    model = Prophet(holidays=holidays)
    model.fit(frame)
    return model


def build_holidays_frame(events: list[tuple[str, date, date]]) -> pd.DataFrame:
    """Converts `SpecialEvent` rows into Prophet's holidays schema. Each
    `(event_type, date_range_start, date_range_end)` tuple becomes one row
    anchored at `date_range_start`, with `upper_window` extending across the
    rest of the tagged range - Prophet applies the same effect to every day
    `[ds, ds + upper_window]` without needing one row per day."""
    if not events:
        return pd.DataFrame(columns=["holiday", "ds", "lower_window", "upper_window"])
    rows = [
        {
            "holiday": event_type,
            "ds": pd.Timestamp(start),
            "lower_window": 0,
            "upper_window": (pd.Timestamp(end) - pd.Timestamp(start)).days,
        }
        for event_type, start, end in events
    ]
    return pd.DataFrame(rows)


def forecast_prophet(model: Prophet, future_index: pd.DatetimeIndex) -> PointForecast:
    future = pd.DataFrame({"ds": future_index})
    forecast = model.predict(future)
    return PointForecast(
        predicted=pd.Series(forecast["yhat"].to_numpy(), index=future_index),
        lower=pd.Series(forecast["yhat_lower"].to_numpy(), index=future_index),
        upper=pd.Series(forecast["yhat_upper"].to_numpy(), index=future_index),
    )
