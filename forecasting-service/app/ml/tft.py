"""Phase 8 (ADR-0026) - Temporal Fusion Transformer via `pytorch-forecasting`,
the GPU-gated `tft` tier ADR-0019 scaffolded a data-quality threshold and
entitlement check for since Phase 1/2, with nothing behind it until now.
`torch`/`lightning`/`pytorch_forecasting` are imported lazily inside each
function - never at module top level - matching `ray`/`mlflow`/`prophet`'s
established convention (ADR-0021, Decision 5) so `app.main`'s import graph
never requires these heavy dependencies reachable.

Unlike SARIMA/Prophet/LightGBM's self-contained fitted objects, a trained
`TemporalFusionTransformer` cannot be pickled directly - its cached
forward-pass output holds a local closure class
(`TupleOutputMixIn.to_network_output.<locals>.Output`) `pickle` can't
resolve, discovered by actually trying it against a real fitted model in
this sandbox. The standard, actually-recommended way to persist a PyTorch
model applies: persist `model.state_dict()` (plain tensors, always
picklable) plus the `TimeSeriesDataSet` spec and fit-time hyperparameters
needed to reconstruct an identical architecture, then rebuild +
`load_state_dict` on every load. `FittedTft` is that picklable bundle - the
thing `app/ml/training.py` actually pickles into `TrainingResult.fitted_model`,
not the live model object (ADR-0026, Decision 3).

`pytorch-forecasting` fixes a fitted model's prediction horizon
(`max_prediction_length`) at training time, unlike SARIMA/Prophet/
LightGBM. `forecast_tft` chunks/rolls a longer request forward across
multiple `holdout_periods`-sized windows, feeding each chunk's own median
prediction back in as the next chunk's encoder context - a real, stated
accuracy tradeoff for long-horizon requests (ADR-0026, Decision 2).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from app.ml.types import PointForecast

# ADR-0026: a stated default, not derived from any per-tenant config - the
# encoder window scales with whatever `holdout_periods` the caller already
# uses (itself derived from `training_service.HOLDOUT_WEEKS`), so this stays
# correct regardless of `interval_minutes` without hardcoding a time unit.
_ENCODER_LENGTH_MULTIPLE = 4
_MODEL_KWARGS: dict[str, Any] = {
    "learning_rate": 0.03,
    "hidden_size": 16,
    "attention_head_size": 1,
    "dropout": 0.1,
    "hidden_continuous_size": 8,
}
_QUANTILES = (0.1, 0.5, 0.9)
_MAX_EPOCHS = 30
# Deterministic weight init + minibatch order - same training data should
# produce the same fitted model on every retrain, not a different one each
# time by chance (also incidentally what makes this module's own tests
# non-flaky).
_RANDOM_SEED = 42


@dataclass
class FittedTft:
    """Everything `forecast_tft` needs to reconstruct predictions - the
    picklable substitute for a live `TemporalFusionTransformer` (see this
    module's docstring for why the live object itself can't be pickled)."""

    state_dict: dict[str, Any]
    training_dataset: Any  # pytorch_forecasting.TimeSeriesDataSet
    encoder_tail: pd.Series
    last_time_idx: int
    max_prediction_length: int


def _build_frame(series: pd.Series, time_idx: np.ndarray[Any, Any]) -> pd.DataFrame:
    idx = series.index
    return pd.DataFrame(
        {
            "value": series.to_numpy(dtype="float32"),
            "time_idx": time_idx,
            "series_id": "0",
            "hour": idx.hour.astype(str).to_numpy(),
            "day_of_week": idx.dayofweek.astype(str).to_numpy(),
        }
    )


def fit_tft(train: pd.Series, holdout_periods: int) -> FittedTft:
    """`holdout_periods` doubles as the backtest window (matching every
    other `fit_X`/`train_and_backtest` call in this module) and the fitted
    model's trained prediction-length ceiling - see this module's docstring
    for why, and `forecast_tft` for how a longer inference-time horizon is
    still supported."""
    import lightning.pytorch as pl
    from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
    from pytorch_forecasting.metrics import QuantileLoss

    pl.seed_everything(_RANDOM_SEED, verbose=False)
    train = train.dropna()
    encoder_length = min(_ENCODER_LENGTH_MULTIPLE * holdout_periods, len(train) - holdout_periods - 1)
    if encoder_length < holdout_periods:
        raise ValueError(f"fit_tft needs at least {2 * holdout_periods + 1} usable points, got {len(train)}")

    time_idx = np.arange(len(train))
    frame = _build_frame(train, time_idx)
    cutoff = int(frame["time_idx"].max()) - holdout_periods

    training_dataset = TimeSeriesDataSet(
        frame[frame.time_idx <= cutoff],
        time_idx="time_idx",
        target="value",
        group_ids=["series_id"],
        min_encoder_length=encoder_length,
        max_encoder_length=encoder_length,
        min_prediction_length=holdout_periods,
        max_prediction_length=holdout_periods,
        time_varying_known_categoricals=["hour", "day_of_week"],
        time_varying_unknown_reals=["value"],
        target_normalizer=None,
    )
    validation_dataset = TimeSeriesDataSet.from_dataset(
        training_dataset, frame, predict=True, stop_randomization=True
    )
    train_dataloader = training_dataset.to_dataloader(train=True, batch_size=64, num_workers=0)
    val_dataloader = validation_dataset.to_dataloader(train=False, batch_size=64, num_workers=0)

    model = TemporalFusionTransformer.from_dataset(
        training_dataset, loss=QuantileLoss(quantiles=list(_QUANTILES)), log_interval=0, **_MODEL_KWARGS
    )
    trainer = _build_trainer()
    trainer.fit(model, train_dataloaders=train_dataloader, val_dataloaders=val_dataloader)
    model.eval()

    return FittedTft(
        state_dict=model.state_dict(),
        training_dataset=training_dataset,
        encoder_tail=train.iloc[-encoder_length:],
        last_time_idx=int(frame["time_idx"].max()),
        max_prediction_length=holdout_periods,
    )


def _build_trainer() -> Any:
    import lightning.pytorch as pl

    # ADR-0026, Decision 4: GPU dispatch is Ray's job (a `num_gpus` resource
    # request on the remote task), not this trainer's - it always runs
    # `accelerator="cpu"` regardless of which node Ray schedules it on,
    # since the CPU path is what's actually been verified in this sandbox.
    return pl.Trainer(
        max_epochs=_MAX_EPOCHS,
        accelerator="cpu",
        logger=False,
        enable_checkpointing=False,
        enable_progress_bar=False,
        enable_model_summary=False,
    )


def _rebuild_model(fitted: FittedTft) -> Any:
    from pytorch_forecasting import TemporalFusionTransformer
    from pytorch_forecasting.metrics import QuantileLoss

    model = TemporalFusionTransformer.from_dataset(
        fitted.training_dataset,
        loss=QuantileLoss(quantiles=list(_QUANTILES)),
        log_interval=0,
        **_MODEL_KWARGS,
    )
    model.load_state_dict(fitted.state_dict)
    model.eval()
    return model


def _predict_one_chunk(
    fitted: FittedTft, model: Any, encoder_series: pd.Series, start_time_idx: int
) -> PointForecast:
    """Always predicts a *full* `fitted.max_prediction_length`-length
    window - `TimeSeriesDataSet.from_dataset(..., predict=True)` forces
    `min_prediction_length = max_prediction_length` internally regardless
    of how the dataset was originally configured (`pytorch_forecasting`'s
    own `from_parameters`), so a combined encoder+future frame shorter than
    the full trained window is rejected outright (`AssertionError: filters
    should not remove entries all entries`) - found by actually running a
    multi-chunk rollout whose final chunk was shorter than the others, not
    predicted from the docs. `forecast_tft` truncates this function's
    always-full-length output down to whatever it actually needs."""
    from pytorch_forecasting import TimeSeriesDataSet

    steps = fitted.max_prediction_length
    freq = encoder_series.index.freq or pd.infer_freq(encoder_series.index)
    future_index = pd.date_range(encoder_series.index[-1], periods=steps + 1, freq=freq)[1:]

    encoder_time_idx = np.arange(start_time_idx - len(encoder_series) + 1, start_time_idx + 1)
    encoder_frame = _build_frame(encoder_series, encoder_time_idx)
    future_frame = pd.DataFrame(
        {
            "value": 0.0,
            "time_idx": np.arange(start_time_idx + 1, start_time_idx + 1 + steps),
            "series_id": "0",
            "hour": future_index.hour.astype(str),
            "day_of_week": future_index.dayofweek.astype(str),
        }
    )
    combined = pd.concat([encoder_frame, future_frame], ignore_index=True)
    prediction_dataset = TimeSeriesDataSet.from_dataset(
        fitted.training_dataset, combined, predict=True, stop_randomization=True
    )
    prediction_dataloader = prediction_dataset.to_dataloader(train=False, batch_size=1, num_workers=0)
    quantiles = model.predict(prediction_dataloader, mode="quantiles")[0].numpy()

    # ADR-0022's exact clipping fix, applied here for the same reason:
    # independently-learned quantile heads can cross, so the point estimate
    # (0.5) is clamped inside [lower, upper] rather than trusted raw.
    lower, predicted, upper = quantiles[:, 0], quantiles[:, 1], quantiles[:, 2]
    predicted = np.clip(predicted, lower, upper)

    return PointForecast(
        predicted=pd.Series(predicted, index=future_index),
        lower=pd.Series(lower, index=future_index),
        upper=pd.Series(upper, index=future_index),
    )


def forecast_tft(fitted: FittedTft, steps: int) -> PointForecast:
    """Chunks a `steps`-length forecast into `fitted.max_prediction_length`-
    sized windows when `steps` exceeds what the model was trained to
    predict in one shot (ADR-0026, Decision 2) - each successive chunk
    feeds the *previous* chunk's own median (0.5-quantile) predictions back
    in as encoder context, a standard rolling-forecast technique for
    fixed-horizon sequence models. A stated accuracy tradeoff: chunks
    beyond the first are conditioned on the model's own prior guesses, not
    ground truth, so uncertainty compounds - unlike SARIMA/Prophet/
    LightGBM, whose single fitted object forecasts an arbitrary horizon
    natively."""
    model = _rebuild_model(fitted)
    chunk_size = fitted.max_prediction_length
    encoder_series = fitted.encoder_tail
    start_time_idx = fitted.last_time_idx
    encoder_window = len(fitted.encoder_tail)

    predicted_parts: list[pd.Series] = []
    lower_parts: list[pd.Series] = []
    upper_parts: list[pd.Series] = []
    remaining = steps
    while remaining > 0:
        this_chunk = min(chunk_size, remaining)
        # Always predicts a full `chunk_size`-length window (see
        # `_predict_one_chunk`'s docstring for why a shorter request isn't
        # possible), truncated here to what's actually still needed - only
        # matters for the *final* chunk, when `remaining < chunk_size`.
        chunk_forecast = _predict_one_chunk(fitted, model, encoder_series, start_time_idx)
        predicted_parts.append(chunk_forecast.predicted.iloc[:this_chunk])
        lower_parts.append(chunk_forecast.lower.iloc[:this_chunk])
        upper_parts.append(chunk_forecast.upper.iloc[:this_chunk])

        # The *full* chunk's own predictions roll the encoder window
        # forward by `chunk_size`, not just `this_chunk` - keeps every
        # chunk after the first starting from a consistent full-window
        # offset, matching what `_predict_one_chunk` was actually trained
        # to consume.
        encoder_series = pd.concat([encoder_series, chunk_forecast.predicted]).iloc[-encoder_window:]
        start_time_idx += chunk_size
        remaining -= this_chunk

    return PointForecast(
        predicted=pd.concat(predicted_parts),
        lower=pd.concat(lower_parts),
        upper=pd.concat(upper_parts),
    )
