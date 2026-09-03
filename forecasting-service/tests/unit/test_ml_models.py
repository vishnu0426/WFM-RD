"""Real SARIMA/Prophet/LightGBM fit + forecast against synthetic data -
these do NOT require a database, `ray`, or `mlflow`, only `statsmodels`/
`prophet`/`lightgbm` themselves (core dependencies of this service). Slower
than the rest of the unit suite (model fitting is genuine compute, not
mocked), kept fast by using small (3-week) synthetic series - not
representative of production data volume, only of correctness.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.ml.backtest import mean_absolute_percentage_error, train_holdout_split
from app.ml.training import TrainingFailure, TrainingResult, train_and_backtest


def _seasonal_series(weeks: int = 3, noise_std: float = 0.5, seed: int = 7) -> pd.Series:
    rng = np.random.default_rng(seed)
    periods = weeks * 24 * 7
    index = pd.date_range("2026-01-01", periods=periods, freq="h")
    daily_pattern = 10 + 5 * np.sin(np.arange(periods) * 2 * np.pi / 24)
    return pd.Series(daily_pattern + rng.normal(0, noise_std, periods), index=index)


def test_sarima_fit_and_forecast_beats_a_naive_flat_baseline() -> None:
    from app.ml.sarima import fit_sarima, forecast_sarima

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)

    fitted = fit_sarima(train, order=(1, 0, 0), seasonal_order=(1, 0, 0, 24))
    forecast = forecast_sarima(fitted, steps=len(holdout))
    forecast.predicted.index = holdout.index

    mape = mean_absolute_percentage_error(holdout, forecast.predicted)
    naive_baseline = pd.Series(train.mean(), index=holdout.index)
    naive_mape = mean_absolute_percentage_error(holdout, naive_baseline)

    assert mape is not None and naive_mape is not None
    assert mape < naive_mape  # the seasonal model should track the daily cycle better than a flat mean


def test_sarima_confidence_interval_contains_the_point_forecast() -> None:
    from app.ml.sarima import fit_sarima, forecast_sarima

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    fitted = fit_sarima(train, order=(1, 0, 0), seasonal_order=(1, 0, 0, 24))
    forecast = forecast_sarima(fitted, steps=len(holdout))

    assert (forecast.lower <= forecast.predicted).all()
    assert (forecast.predicted <= forecast.upper).all()


def test_sarima_handles_missing_values_in_the_training_series() -> None:
    """SARIMAX's state-space implementation should fit without error even
    with `NaN` gaps (ADR-0021's stated missing-data handling)."""
    from app.ml.sarima import fit_sarima, forecast_sarima

    series = _seasonal_series()
    series.iloc[10:15] = np.nan
    train, holdout = train_holdout_split(series, holdout_periods=24)

    fitted = fit_sarima(train, order=(1, 0, 0), seasonal_order=(1, 0, 0, 24))
    forecast = forecast_sarima(fitted, steps=len(holdout))
    assert len(forecast.predicted) == len(holdout)
    assert not forecast.predicted.isna().any()


def test_prophet_fit_and_forecast_beats_a_naive_flat_baseline() -> None:
    from app.ml.prophet_model import fit_prophet, forecast_prophet

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)

    model = fit_prophet(train)
    forecast = forecast_prophet(model, holdout.index)

    mape = mean_absolute_percentage_error(holdout, forecast.predicted)
    naive_baseline = pd.Series(train.mean(), index=holdout.index)
    naive_mape = mean_absolute_percentage_error(holdout, naive_baseline)

    assert mape is not None and naive_mape is not None
    assert mape < naive_mape


def test_prophet_confidence_interval_contains_the_point_forecast() -> None:
    from app.ml.prophet_model import fit_prophet, forecast_prophet

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    model = fit_prophet(train)
    forecast = forecast_prophet(model, holdout.index)

    assert (forecast.lower <= forecast.predicted).all()
    assert (forecast.predicted <= forecast.upper).all()


def test_prophet_drops_missing_rows_rather_than_erroring() -> None:
    from app.ml.prophet_model import fit_prophet, forecast_prophet

    series = _seasonal_series()
    series.iloc[10:15] = np.nan
    train, holdout = train_holdout_split(series, holdout_periods=24)

    model = fit_prophet(train)
    forecast = forecast_prophet(model, holdout.index)
    assert len(forecast.predicted) == len(holdout)


def test_lightgbm_fit_and_forecast_beats_a_naive_flat_baseline() -> None:
    from app.ml.lightgbm_model import fit_lightgbm, forecast_lightgbm

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)

    boosters = fit_lightgbm(train)
    forecast = forecast_lightgbm(boosters, holdout.index)

    mape = mean_absolute_percentage_error(holdout, forecast.predicted)
    naive_baseline = pd.Series(train.mean(), index=holdout.index)
    naive_mape = mean_absolute_percentage_error(holdout, naive_baseline)

    assert mape is not None and naive_mape is not None
    assert mape < naive_mape


def test_lightgbm_confidence_interval_contains_the_point_forecast() -> None:
    """Guards ADR-0022 Decision 2's clipping - quantile regressors are fit
    independently and can otherwise cross the point estimate."""
    from app.ml.lightgbm_model import fit_lightgbm, forecast_lightgbm

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    boosters = fit_lightgbm(train)
    forecast = forecast_lightgbm(boosters, holdout.index)

    assert (forecast.lower <= forecast.predicted).all()
    assert (forecast.predicted <= forecast.upper).all()


def test_lightgbm_drops_missing_rows_rather_than_erroring() -> None:
    from app.ml.lightgbm_model import fit_lightgbm, forecast_lightgbm

    series = _seasonal_series()
    series.iloc[10:15] = np.nan
    train, holdout = train_holdout_split(series, holdout_periods=24)

    boosters = fit_lightgbm(train)
    forecast = forecast_lightgbm(boosters, holdout.index)
    assert len(forecast.predicted) == len(holdout)


def test_build_holidays_frame_of_no_events_is_empty_with_the_expected_columns() -> None:
    from app.ml.prophet_model import build_holidays_frame

    frame = build_holidays_frame([])
    assert frame.empty
    assert list(frame.columns) == ["holiday", "ds", "lower_window", "upper_window"]


def test_build_holidays_frame_computes_upper_window_from_the_date_range() -> None:
    import datetime as dt

    from app.ml.prophet_model import build_holidays_frame

    frame = build_holidays_frame([("holiday", dt.date(2026, 12, 24), dt.date(2026, 12, 26))])
    assert len(frame) == 1
    row = frame.iloc[0]
    assert row["holiday"] == "holiday"
    assert row["lower_window"] == 0
    assert row["upper_window"] == 2  # Dec 24 -> Dec 26 spans 2 extra days


def test_prophet_fits_with_a_holidays_frame_without_erroring() -> None:
    import datetime as dt

    from app.ml.prophet_model import build_holidays_frame, fit_prophet, forecast_prophet

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    holidays = build_holidays_frame([("holiday", dt.date(2026, 1, 10), dt.date(2026, 1, 10))])

    model = fit_prophet(train, holidays=holidays)
    forecast = forecast_prophet(model, holdout.index)
    assert len(forecast.predicted) == len(holdout)


def test_lightgbm_uses_only_calendar_features_derived_from_the_index() -> None:
    """ADR-0022 Decision 1: two series with identical calendar structure but
    different start dates (so absolute timestamps differ, but day-of-week/
    hour/minute-of-day repeat) should fit to materially the same function,
    since nothing about the *absolute* date is a feature."""
    from app.ml.lightgbm_model import _build_features

    idx_a = pd.date_range("2026-01-05", periods=48, freq="h")  # a Monday
    idx_b = pd.date_range("2026-02-02", periods=48, freq="h")  # also a Monday
    features_a = _build_features(idx_a).reset_index(drop=True)
    features_b = _build_features(idx_b).reset_index(drop=True)
    pd.testing.assert_frame_equal(features_a, features_b)


@pytest.mark.parametrize("model_type", ["sarima", "prophet", "lightgbm"])
def test_train_and_backtest_returns_a_populated_result_for_each_supported_type(model_type: str) -> None:
    series = _seasonal_series()
    result = train_and_backtest(model_type, series, holdout_periods=24)

    assert isinstance(result, TrainingResult)
    assert result.model_type == model_type
    assert result.backtest_mape is not None
    assert result.backtest_wfa is not None
    assert result.training_data_window_start < result.training_data_window_end


def test_train_and_backtest_rejects_an_unsupported_model_type() -> None:
    series = _seasonal_series()
    with pytest.raises(ValueError, match="only supports"):
        train_and_backtest("neuralprophet", series, holdout_periods=24)


def test_training_failure_is_a_distinct_type_from_training_result() -> None:
    """Guards the `isinstance` branch `training_service.retrain` relies on
    to isolate one candidate's failure from the rest of the batch."""
    failure = TrainingFailure(model_type="sarima", error="did not converge")
    assert not isinstance(failure, TrainingResult)
