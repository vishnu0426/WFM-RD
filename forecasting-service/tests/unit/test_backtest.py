"""§0's "defined backtest methodology" made concrete and verified: pure
`pandas`/`numpy` math, no model fitting, no DB."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.ml.backtest import (
    fill_missing_with_nan,
    mean_absolute_percentage_error,
    to_float_series,
    train_holdout_split,
    weighted_forecast_accuracy,
)


def _series(values: list[float], start: str = "2026-01-01", freq: str = "h") -> pd.Series:
    index = pd.date_range(start, periods=len(values), freq=freq)
    return pd.Series(values, index=index)


def test_train_holdout_split_takes_the_last_n_points_as_holdout() -> None:
    series = _series([float(i) for i in range(10)])
    train, holdout = train_holdout_split(series, holdout_periods=3)
    assert list(train) == [0, 1, 2, 3, 4, 5, 6]
    assert list(holdout) == [7, 8, 9]


def test_train_holdout_split_rejects_a_holdout_not_smaller_than_the_series() -> None:
    series = _series([1.0, 2.0, 3.0])
    with pytest.raises(ValueError, match="not enough"):
        train_holdout_split(series, holdout_periods=3)


def test_train_holdout_split_rejects_non_positive_holdout() -> None:
    series = _series([1.0, 2.0, 3.0])
    with pytest.raises(ValueError, match="positive"):
        train_holdout_split(series, holdout_periods=0)


def test_mape_is_zero_for_a_perfect_forecast() -> None:
    actual = _series([10.0, 20.0, 30.0])
    assert mean_absolute_percentage_error(actual, actual) == pytest.approx(0.0)


def test_mape_matches_hand_computed_value() -> None:
    actual = _series([100.0, 200.0])
    predicted = _series([110.0, 180.0])
    # |100-110|/100=0.10, |200-180|/200=0.10 -> mean 10%
    assert mean_absolute_percentage_error(actual, predicted) == pytest.approx(10.0)


def test_mape_excludes_zero_actual_points_rather_than_dividing_by_zero() -> None:
    actual = _series([0.0, 100.0])
    predicted = _series([5.0, 90.0])
    # Only the second point (actual=100) is usable: |100-90|/100 = 10%
    assert mean_absolute_percentage_error(actual, predicted) == pytest.approx(10.0)


def test_mape_is_none_when_every_actual_is_zero() -> None:
    actual = _series([0.0, 0.0])
    predicted = _series([1.0, 2.0])
    assert mean_absolute_percentage_error(actual, predicted) is None


def test_wfa_is_100_for_a_perfect_forecast() -> None:
    actual = _series([10.0, 20.0, 30.0])
    assert weighted_forecast_accuracy(actual, actual) == pytest.approx(100.0)


def test_wfa_matches_hand_computed_value() -> None:
    actual = _series([100.0, 200.0])
    predicted = _series([110.0, 180.0])
    # total_actual=300, total_abs_error=|100-110|+|200-180|=30 -> 1 - 30/300 = 90%
    assert weighted_forecast_accuracy(actual, predicted) == pytest.approx(90.0)


def test_wfa_is_none_when_total_actual_is_zero() -> None:
    actual = _series([0.0, 0.0])
    predicted = _series([1.0, -1.0])
    assert weighted_forecast_accuracy(actual, predicted) is None


def test_wfa_is_not_dominated_by_a_single_low_volume_outlier_the_way_mape_can_be() -> None:
    """A near-zero-volume interval with 100% relative error blows up MAPE
    but barely moves WFA - the exact property WFA is chosen for (ADR-0021's
    docstring in backtest.py)."""
    actual = _series([0.01, 1000.0])
    predicted = _series([1.0, 990.0])
    mape = mean_absolute_percentage_error(actual, predicted)
    wfa = weighted_forecast_accuracy(actual, predicted)
    assert mape is not None and mape > 1000  # dominated by the 0.01 -> 1.0 point
    assert wfa is not None and wfa > 98  # barely affected


def test_fill_missing_with_nan_reindexes_onto_a_full_regular_grid() -> None:
    index = pd.DatetimeIndex(["2026-01-01 00:00", "2026-01-01 02:00"])
    series = pd.Series([1.0, 2.0], index=index)
    filled = fill_missing_with_nan(series, freq="h")
    assert len(filled) == 3
    assert np.isnan(filled.iloc[1])


def test_fill_missing_with_nan_is_a_noop_for_an_empty_series() -> None:
    series = pd.Series([], dtype=float)
    assert fill_missing_with_nan(series, freq="h").empty


def test_to_float_series_converts_none_to_nan_and_sorts_by_index() -> None:
    values = [
        (pd.Timestamp("2026-01-01 01:00"), 2.0),
        (pd.Timestamp("2026-01-01 00:00"), None),
    ]
    series = to_float_series(values)
    assert list(series.index) == sorted(series.index)
    assert np.isnan(series.iloc[0])
    assert series.iloc[1] == 2.0


def test_to_float_series_of_empty_input_is_an_empty_series() -> None:
    assert to_float_series([]).empty
