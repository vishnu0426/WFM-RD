"""§0's "no model performance numbers stated as fact without a defined
backtest methodology" rule, made concrete: a fixed holdout split and two
explicitly defined accuracy metrics. Pure functions, `pandas`/`numpy` only -
no DB, no `ray`, no `mlflow` - independently unit-testable and reusable by
whichever model-fitting code needs them (ADR-0021).
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd


def train_holdout_split(series: pd.Series, holdout_periods: int) -> tuple[pd.Series, pd.Series]:
    """Splits a time-ordered series into `(train, holdout)`, holdout being
    the last `holdout_periods` observations. Raises `ValueError` if the
    series doesn't have enough points for a non-empty train set - a caller
    passing too little data is a bug upstream (the `DataQualityCheck` gate
    should have already rejected it), not a case to silently degrade."""
    if holdout_periods <= 0:
        raise ValueError("holdout_periods must be positive")
    if len(series) <= holdout_periods:
        raise ValueError(
            f"series has {len(series)} points, not enough for a {holdout_periods}-point holdout"
        )
    return series.iloc[:-holdout_periods], series.iloc[-holdout_periods:]


def mean_absolute_percentage_error(actual: pd.Series, predicted: pd.Series) -> float | None:
    """MAPE, as a percentage. Points where `actual == 0` are excluded (the
    ratio is undefined there) rather than causing a division error or being
    silently treated as 0% error. Returns `None` if every point is excluded
    (no usable point to compute a percentage error against)."""
    aligned_actual, aligned_predicted = actual.align(predicted, join="inner")
    mask = aligned_actual != 0
    if not mask.any():
        return None
    errors = (aligned_actual[mask] - aligned_predicted[mask]).abs() / aligned_actual[mask].abs()
    return float(errors.mean() * 100)


def weighted_forecast_accuracy(actual: pd.Series, predicted: pd.Series) -> float | None:
    """Weighted Forecast Accuracy (WFA), as a percentage:
    `(1 - sum(|actual - predicted|) / sum(actual)) * 100`. Volume-weighted,
    unlike MAPE's per-interval average - a handful of near-zero-volume
    intervals with large relative error don't dominate the score the way
    they can in MAPE. Returns `None` if `sum(actual) == 0` (undefined)."""
    aligned_actual, aligned_predicted = actual.align(predicted, join="inner")
    total_actual = aligned_actual.sum()
    if total_actual == 0:
        return None
    total_absolute_error = (aligned_actual - aligned_predicted).abs().sum()
    return float((1 - total_absolute_error / total_actual) * 100)


def fill_missing_with_nan(series: pd.Series, freq: str) -> pd.Series:
    """Reindexes a possibly-gappy series onto a full regular grid at `freq`,
    filling gaps with `NaN` rather than interpolating - callers decide how
    their specific model handles missingness (SARIMAX natively supports NaN
    endog values; Prophet-facing code drops NaN rows instead, see
    `prophet_model.py`)."""
    if series.empty:
        return series
    full_index = pd.date_range(series.index.min(), series.index.max(), freq=freq)
    return series.reindex(full_index)


def to_float_series(values: Sequence[tuple[object, object]]) -> pd.Series:
    """Builds a `pd.Series[float]` from `(interval_start, decimal_value)`
    pairs (as read from `HistoricalActual` rows), sorted by index. `None`
    values become `NaN`."""
    index, raw_values = zip(*values, strict=True) if values else ((), ())
    floats = [float(v) if v is not None else np.nan for v in raw_values]
    return pd.Series(floats, index=pd.DatetimeIndex(index)).sort_index()
