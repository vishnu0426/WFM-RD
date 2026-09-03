"""MLflow artifact tracking (ADR-0021, Decision 4). `mlflow` is imported
lazily inside each function - never at module top level - so `app.main`'s
import graph never requires a reachable MLflow tracking store (ADR-0021,
Decision 5). Every `ForecastModel.artifact_uri` is the exact string
`log_model` returns here, which is what §3.2's `forecastModelProvenance`
explainability query (out of scope until it's built) would eventually
resolve back to a training run.
"""

from __future__ import annotations

import pickle
import tempfile
import uuid
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.ml.training import TrainingResult


def log_model(
    result: TrainingResult,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    target_metric: str,
) -> str:
    """Logs params/metrics/the fitted model artifact to MLflow, returns the
    run's `artifact_uri`. `result.fitted_model` is already pickled bytes
    (`app/ml/training.py` - pickled inside the Ray task, before it ever
    enters Ray's object store, to sidestep a real read-only-buffer crash
    found by testing this against a real Ray cluster) - written directly,
    not re-pickled. Not a specific MLflow model flavor
    (`mlflow.statsmodels`/a community `mlflow.prophet` flavor), so this
    function stays uniform across model types, at the cost of losing
    flavor-specific niceties (e.g. MLflow's own model-serving wrappers).
    `load_model` below is this function's exact inverse."""
    import mlflow

    settings = get_settings()
    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
    mlflow.set_experiment(settings.mlflow_experiment_name)

    run_name = f"{tenant_id}-{org_unit_id}-{target_metric}-{result.model_type}"
    with mlflow.start_run(run_name=run_name) as run:
        mlflow.log_params(
            {
                "model_type": result.model_type,
                "tenant_id": str(tenant_id),
                "org_unit_id": str(org_unit_id),
                "target_metric": target_metric,
            }
        )
        if result.backtest_mape is not None:
            mlflow.log_metric("backtest_mape", result.backtest_mape)
        if result.backtest_wfa is not None:
            mlflow.log_metric("backtest_wfa", result.backtest_wfa)

        with tempfile.TemporaryDirectory() as tmp_dir:
            model_path = Path(tmp_dir) / "model.pkl"
            model_path.write_bytes(result.fitted_model)
            mlflow.log_artifact(str(model_path))

        return str(run.info.artifact_uri)


def load_model(artifact_uri: str) -> Any:
    """Inverse of `log_model` - downloads and unpickles the fitted model an
    `artifact_uri` points at, for `inference_service.py` to call
    `.forecast()`/`.predict()` on."""
    import mlflow

    settings = get_settings()
    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)

    local_path = mlflow.artifacts.download_artifacts(artifact_uri=f"{artifact_uri}/model.pkl")
    with Path(local_path).open("rb") as handle:
        return pickle.load(handle)
