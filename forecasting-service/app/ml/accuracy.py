"""Per-interval accuracy math (ADR-0025, Decision 2). Pure - no DB. Mirrors
`app/ml/backtest.py`'s zero-actual guard for MAPE, for consistency between
training-time backtest MAPE and production `ForecastAccuracyLog` MAPE.
"""

from __future__ import annotations


def interval_mape(actual: float, predicted: float) -> float | None:
    """`None` when `actual == 0` (undefined ratio) - the caller does not
    write a `ForecastAccuracyLog.mape` value in that case, mirroring
    `backtest.mean_absolute_percentage_error`'s same guard."""
    if actual == 0:
        return None
    return abs(actual - predicted) / abs(actual) * 100


def interval_bias(actual: float, predicted: float) -> float | None:
    """Signed: positive means over-forecast, negative means under-forecast.
    `None` when `actual == 0`, same guard as `interval_mape`."""
    if actual == 0:
        return None
    return (predicted - actual) / actual * 100
