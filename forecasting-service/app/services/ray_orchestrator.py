"""Ray-based parallel training (§0's "Ray for distributed training across
queues" requirement, ADR-0021 Decision 1: run synchronously within
`/retrain`, `ray.get()`-blocked, since that endpoint's own SLO already
budgets up to 2 minutes for exactly this). `ray` is imported at this
module's top level - safe because nothing imports this module except
`training_service.retrain`, and it does so lazily inside its own function
body (ADR-0021 Decision 5), so `app.main`'s import graph never requires a
reachable Ray cluster.
"""

from __future__ import annotations

import logging

import pandas as pd
import ray

from app.config import get_settings
from app.ml.training import TrainingFailure, TrainingResult, train_and_backtest

_ray_initialized = False


def _ensure_ray_initialized() -> None:
    global _ray_initialized
    if not _ray_initialized:
        ray.init(ignore_reinit_error=True, include_dashboard=False, logging_level=logging.WARNING)
        _ray_initialized = True


@ray.remote
def _train_and_backtest_task(
    model_type: str, series: pd.Series, holdout_periods: int, holidays: pd.DataFrame | None
) -> TrainingResult:
    return train_and_backtest(model_type, series, holdout_periods, holidays=holidays)


def train_candidates_in_parallel(
    candidates: list[tuple[str, pd.Series, int, pd.DataFrame | None]],
) -> list[TrainingResult | TrainingFailure]:
    """`candidates` is `(model_type, series, holdout_periods, holidays)`
    tuples - one per model type being attempted for a single org unit/target
    metric this retrain call. `holidays` (ADR-0025, Decision 5) is only
    consumed by the `prophet` branch of `train_and_backtest`; SARIMA/LightGBM
    candidates carry it along unused, keeping one uniform tuple shape rather
    than a model-type-conditional call signature. All `.remote()` calls are
    dispatched up front (Ray schedules them concurrently - one process
    locally in dev, a real cluster in production); results are then
    collected one at a time so a single model type's training failure (e.g.
    a SARIMAX convergence error) surfaces as a `TrainingFailure` for that
    model type alone, rather than aborting every candidate in the batch the
    way a bare `ray.get(all_refs)` would on the first exception. `tft`
    candidates are dispatched with a `num_gpus` resource request
    (`settings.tft_num_gpus`, ADR-0026 Decision 4) - `0` by default, so
    they stay CPU-scheduled unless a real GPU-node deployment opts in."""
    _ensure_ray_initialized()
    num_gpus = get_settings().tft_num_gpus
    dispatched = [
        (
            model_type,
            _train_and_backtest_task.options(num_gpus=num_gpus if model_type == "tft" else 0).remote(
                model_type, series, holdout_periods, holidays
            ),
        )
        for model_type, series, holdout_periods, holidays in candidates
    ]

    results: list[TrainingResult | TrainingFailure] = []
    for model_type, ref in dispatched:
        try:
            results.append(ray.get(ref))
        except Exception as exc:  # noqa: BLE001 - one candidate's failure must not sink the batch
            results.append(TrainingFailure(model_type=model_type, error=str(exc)))
    return results
