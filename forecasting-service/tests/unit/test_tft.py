"""Real `pytorch-forecasting` fit + forecast (ADR-0026) - no DB, no Ray, no
MLflow. Slower than the rest of the unit suite (genuine model training, not
mocked), kept bounded by a small synthetic series and few epochs, same
posture `test_ml_models.py` already takes for SARIMA/Prophet/LightGBM.
"""

from __future__ import annotations

import pickle

import numpy as np
import pandas as pd
import pytest

from app.ml.backtest import mean_absolute_percentage_error, train_holdout_split


def _seasonal_series(weeks: int = 3, noise_std: float = 0.5, seed: int = 21) -> pd.Series:
    rng = np.random.default_rng(seed)
    periods = weeks * 24 * 7
    index = pd.date_range("2026-01-01", periods=periods, freq="h")
    daily_pattern = 10 + 5 * np.sin(np.arange(periods) * 2 * np.pi / 24)
    return pd.Series(daily_pattern + rng.normal(0, noise_std, periods), index=index)


def test_tft_fit_and_forecast_beats_a_naive_flat_baseline() -> None:
    from app.ml.tft import fit_tft, forecast_tft

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)

    fitted = fit_tft(train, holdout_periods=24)
    forecast = forecast_tft(fitted, steps=len(holdout))
    forecast.predicted.index = holdout.index

    mape = mean_absolute_percentage_error(holdout, forecast.predicted)
    naive_baseline = pd.Series(train.mean(), index=holdout.index)
    naive_mape = mean_absolute_percentage_error(holdout, naive_baseline)

    assert mape is not None and naive_mape is not None
    assert mape < naive_mape


def test_tft_confidence_interval_contains_the_point_forecast() -> None:
    from app.ml.tft import fit_tft, forecast_tft

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    fitted = fit_tft(train, holdout_periods=24)
    forecast = forecast_tft(fitted, steps=len(holdout))

    assert (forecast.lower <= forecast.predicted).all()
    assert (forecast.predicted <= forecast.upper).all()


def test_tft_forecast_future_index_matches_the_holdout_when_contiguous() -> None:
    """`forecast_tft`'s own computed index (built from the encoder tail's
    last timestamp) should line up exactly with a holdout that's
    contiguous with training - the property `train_and_backtest`'s tft
    branch relies on before it explicitly overwrites the index anyway."""
    from app.ml.tft import fit_tft, forecast_tft

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    fitted = fit_tft(train, holdout_periods=24)
    forecast = forecast_tft(fitted, steps=len(holdout))

    assert list(forecast.predicted.index) == list(holdout.index)


def test_tft_forecast_rolls_forward_past_its_trained_horizon() -> None:
    """ADR-0026, Decision 2 - a `steps` request longer than
    `holdout_periods` (the model's trained prediction ceiling) is chunked
    into multiple rolling windows rather than erroring or silently
    truncating."""
    from app.ml.tft import fit_tft, forecast_tft

    series = _seasonal_series()
    train, _holdout = train_holdout_split(series, holdout_periods=24)
    fitted = fit_tft(train, holdout_periods=24)

    forecast = forecast_tft(fitted, steps=60)  # 2.5x the 24-period training ceiling

    assert len(forecast.predicted) == 60
    assert len(forecast.lower) == 60
    assert len(forecast.upper) == 60
    # Each chunk's future_index continues strictly forward from the last -
    # no overlap, no gap.
    assert forecast.predicted.index.is_monotonic_increasing
    assert forecast.predicted.index.is_unique


def test_fitted_tft_round_trips_through_pickle() -> None:
    """The real bug this module's docstring documents: the live
    `TemporalFusionTransformer` itself can't be pickled
    (`AttributeError: Can't get local object ...`) - `FittedTft` (state_dict
    + dataset spec, not the live model) is what actually gets pickled, and
    must survive a pickle/unpickle round trip and still forecast
    correctly afterward."""
    from app.ml.tft import fit_tft, forecast_tft

    series = _seasonal_series()
    train, holdout = train_holdout_split(series, holdout_periods=24)
    fitted = fit_tft(train, holdout_periods=24)

    blob = pickle.dumps(fitted)
    restored = pickle.loads(blob)

    forecast = forecast_tft(restored, steps=len(holdout))
    assert len(forecast.predicted) == len(holdout)
    assert not forecast.predicted.isna().any()


def test_fit_tft_rejects_too_little_data() -> None:
    from app.ml.tft import fit_tft

    # `fit_tft` needs `2 * holdout_periods + 1` usable points at minimum -
    # 30 points is short of the 49 a 24-period holdout requires.
    index = pd.date_range("2026-01-01", periods=30, freq="h")
    series = pd.Series(np.arange(30, dtype=float), index=index)
    with pytest.raises(ValueError, match="usable points"):
        fit_tft(series, holdout_periods=24)


@pytest.mark.parametrize("model_type", ["tft"])
def test_train_and_backtest_returns_a_populated_result_for_tft(model_type: str) -> None:
    from app.ml.training import TrainingResult, train_and_backtest

    series = _seasonal_series()
    result = train_and_backtest(model_type, series, holdout_periods=24)

    assert isinstance(result, TrainingResult)
    assert result.model_type == "tft"
    assert result.backtest_mape is not None
    assert result.backtest_wfa is not None
    assert isinstance(result.fitted_model, bytes)
    assert len(result.fitted_model) > 0
