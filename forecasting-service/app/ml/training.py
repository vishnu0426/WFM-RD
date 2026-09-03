"""Model-type-agnostic training + backtest orchestration. No `ray`, no
`mlflow`, no DB - just `app/ml/sarima.py`/`prophet_model.py`/
`lightgbm_model.py` + `backtest.py`. Kept independent of orchestration/
registry concerns so it can be unit-tested directly and wrapped by a
`ray.remote` task (`app/services/ray_orchestrator.py`) without that wrapper
needing to know anything about the individual model types' APIs.

`TrainingResult.fitted_model` is pre-pickled `bytes`, not the live fitted
object - discovered the hard way (real execution against a real Ray cluster,
only possible once this project's actual Python 3.11/3.12 deployment target
was available to test against): Ray's object store deserializes returned
numpy arrays as read-only zero-copy buffers, and reconstructing a fitted
SARIMAXResultsWrapper's internal Cython state (`statsmodels.tsa.statespace.
_initialization`) needs a *writable* buffer, so returning the live object
through `ray.get()` crashes with `ValueError: buffer source array is
read-only` for SARIMA specifically (Prophet's pure-Python state doesn't hit
this). Pickling inside the task, before the value ever enters Ray's object
store, sidesteps the zero-copy numpy path entirely - confirmed by testing
both ways against real Ray. `mlflow_registry.log_model` writes these bytes
directly rather than re-pickling.
"""

from __future__ import annotations

import pickle
from dataclasses import dataclass
from datetime import datetime

import pandas as pd

from app.ml.backtest import (
    mean_absolute_percentage_error,
    train_holdout_split,
    weighted_forecast_accuracy,
)

SUPPORTED_MODEL_TYPES = ("sarima", "prophet", "lightgbm", "tft")


@dataclass(frozen=True)
class TrainingResult:
    model_type: str
    backtest_mape: float | None
    backtest_wfa: float | None
    fitted_model: bytes
    training_data_window_start: datetime
    training_data_window_end: datetime


@dataclass(frozen=True)
class TrainingFailure:
    model_type: str
    error: str


def train_and_backtest(
    model_type: str, series: pd.Series, holdout_periods: int, holidays: pd.DataFrame | None = None
) -> TrainingResult:
    if model_type not in SUPPORTED_MODEL_TYPES:
        raise ValueError(
            f"train_and_backtest only supports {SUPPORTED_MODEL_TYPES} in this phase, got {model_type!r}"
        )

    train, holdout = train_holdout_split(series, holdout_periods)

    if model_type == "sarima":
        from app.ml.sarima import fit_sarima, forecast_sarima

        fitted = fit_sarima(train)
        forecast = forecast_sarima(fitted, steps=len(holdout))
        forecast.predicted.index = holdout.index
    elif model_type == "prophet":
        from app.ml.prophet_model import fit_prophet, forecast_prophet

        fitted = fit_prophet(train, holidays=holidays)
        forecast = forecast_prophet(fitted, holdout.index)
    elif model_type == "lightgbm":
        from app.ml.lightgbm_model import fit_lightgbm, forecast_lightgbm

        fitted = fit_lightgbm(train)
        forecast = forecast_lightgbm(fitted, holdout.index)
    else:
        from app.ml.tft import fit_tft, forecast_tft

        fitted = fit_tft(train, holdout_periods)
        forecast = forecast_tft(fitted, steps=len(holdout))
        forecast.predicted.index = holdout.index
        forecast.lower.index = holdout.index
        forecast.upper.index = holdout.index

    return TrainingResult(
        model_type=model_type,
        backtest_mape=mean_absolute_percentage_error(holdout, forecast.predicted),
        backtest_wfa=weighted_forecast_accuracy(holdout, forecast.predicted),
        fitted_model=pickle.dumps(fitted),
        training_data_window_start=series.index.min().to_pydatetime(),
        training_data_window_end=series.index.max().to_pydatetime(),
    )
