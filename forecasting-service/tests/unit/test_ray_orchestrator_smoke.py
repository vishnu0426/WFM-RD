"""Real Ray + real MLflow, no fakes - the piece that was previously only
verified by structural review (`ray_orchestrator.py`/`mlflow_registry.py`),
now exercised for real now that this project's actual Python 3.11/3.12
deployment target is available to run it against.

This is where a real, non-hypothetical bug was caught: Ray's object store
deserializes returned numpy arrays as read-only zero-copy buffers, which
crashed reconstructing a fitted SARIMAXResultsWrapper's internal Cython
state (`ValueError: buffer source array is read-only`) when the live object
was returned directly through `ray.get()`. Fixed by pickling the fitted
model to bytes *inside* the Ray task (`app/ml/training.py`'s
`train_and_backtest`), before the value ever enters Ray's object store -
`TrainingResult.fitted_model` is `bytes`, not a live model object, for
exactly this reason. This test is what would have caught that regression
before it shipped.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.ml.training import TrainingFailure, TrainingResult


def _seasonal_series(weeks: int = 3, seed: int = 11) -> pd.Series:
    rng = np.random.default_rng(seed)
    periods = weeks * 24 * 7
    index = pd.date_range("2026-01-01", periods=periods, freq="h")
    pattern = 10 + 5 * np.sin(np.arange(periods) * 2 * np.pi / 24)
    return pd.Series(pattern + rng.normal(0, 0.5, periods), index=index)


@pytest.mark.parametrize("model_type", ["sarima", "prophet", "lightgbm"])
def test_ray_orchestrator_trains_each_model_type_for_real(model_type: str) -> None:
    from app.services.ray_orchestrator import train_candidates_in_parallel

    series = _seasonal_series()
    results = train_candidates_in_parallel([(model_type, series, 24, None)])

    assert len(results) == 1
    result = results[0]
    assert isinstance(result, TrainingResult), (
        f"expected a TrainingResult for {model_type}, got {result}"
    )
    assert result.model_type == model_type
    assert result.backtest_mape is not None
    assert isinstance(result.fitted_model, bytes)
    assert len(result.fitted_model) > 0


def test_ray_orchestrator_trains_all_three_model_types_in_parallel_without_cross_contamination() -> None:
    from app.services.ray_orchestrator import train_candidates_in_parallel

    series = _seasonal_series()
    results = train_candidates_in_parallel(
        [("sarima", series, 24, None), ("prophet", series, 24, None), ("lightgbm", series, 24, None)]
    )

    by_type = {r.model_type: r for r in results if isinstance(r, TrainingResult)}
    assert set(by_type) == {"sarima", "prophet", "lightgbm"}
    for result in by_type.values():
        assert result.backtest_mape is not None


def test_ray_orchestrator_isolates_an_unsupported_model_type_as_a_failure() -> None:
    """`train_and_backtest` raises `ValueError` for anything outside
    {sarima, prophet, lightgbm} (this platform's scope so far) - the Ray
    wrapper must turn that into a `TrainingFailure` for that candidate, not
    crash the whole dispatched batch."""
    from app.services.ray_orchestrator import train_candidates_in_parallel

    series = _seasonal_series()
    results = train_candidates_in_parallel(
        [("neuralprophet", series, 24, None), ("sarima", series, 24, None)]
    )

    by_type = {r.model_type: r for r in results}
    assert isinstance(by_type["neuralprophet"], TrainingFailure)
    assert isinstance(by_type["sarima"], TrainingResult)


def test_mlflow_log_and_load_round_trips_a_real_fitted_sarima_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings
    from app.ml.sarima import forecast_sarima
    from app.ml.training import train_and_backtest
    from app.services import mlflow_registry

    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"file:{tmp_path / 'mlruns'}")
    get_settings.cache_clear()

    series = _seasonal_series()
    result = train_and_backtest("sarima", series, holdout_periods=24)

    artifact_uri = mlflow_registry.log_model(
        result, tenant_id=uuid.uuid4(), org_unit_id=uuid.uuid4(), target_metric="volume"
    )
    assert artifact_uri.startswith("file:")

    restored = mlflow_registry.load_model(artifact_uri)
    forecast = forecast_sarima(restored, steps=5)
    assert len(forecast.predicted) == 5

    get_settings.cache_clear()


def test_mlflow_log_and_load_round_trips_a_real_fitted_prophet_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings
    from app.ml.prophet_model import forecast_prophet
    from app.ml.training import train_and_backtest
    from app.services import mlflow_registry

    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"file:{tmp_path / 'mlruns'}")
    get_settings.cache_clear()

    series = _seasonal_series()
    result = train_and_backtest("prophet", series, holdout_periods=24)

    artifact_uri = mlflow_registry.log_model(
        result, tenant_id=uuid.uuid4(), org_unit_id=uuid.uuid4(), target_metric="volume"
    )
    restored = mlflow_registry.load_model(artifact_uri)
    future_index = pd.date_range("2026-06-01", periods=5, freq="h")
    forecast = forecast_prophet(restored, future_index)
    assert len(forecast.predicted) == 5

    get_settings.cache_clear()


def test_mlflow_log_and_load_round_trips_a_real_fitted_lightgbm_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings
    from app.ml.lightgbm_model import forecast_lightgbm
    from app.ml.training import train_and_backtest
    from app.services import mlflow_registry

    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"file:{tmp_path / 'mlruns'}")
    get_settings.cache_clear()

    series = _seasonal_series()
    result = train_and_backtest("lightgbm", series, holdout_periods=24)

    artifact_uri = mlflow_registry.log_model(
        result, tenant_id=uuid.uuid4(), org_unit_id=uuid.uuid4(), target_metric="volume"
    )
    restored = mlflow_registry.load_model(artifact_uri)
    future_index = pd.date_range("2026-06-01", periods=5, freq="h")
    forecast = forecast_lightgbm(restored, future_index)
    assert len(forecast.predicted) == 5

    get_settings.cache_clear()
