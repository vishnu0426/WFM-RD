"""Requires a reachable Postgres with the Phase 1 migration already applied
(`docker-compose up -d && alembic upgrade head`, run from
`forecasting-service/`) - same "requires the steps above" posture as
Module 01/02's `test/integration` suite, not testcontainers (mirroring
`test/integration/rls-isolation.spec.ts`, which also connects directly via
env vars rather than spinning up its own container).
"""

from __future__ import annotations

import os
import pickle
import sys
import types
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.ml.training import TrainingFailure, TrainingResult
from tests.jwt_test_helpers import (  # noqa: F401 - `_patch_jwks_client` is an autouse fixture, not called directly
    _patch_jwks_client,
    auth_headers,
    make_bearer_token,
)


def _url(username: str, password_env: str, default_password: str) -> str:
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "5432")
    database = os.getenv("DB_DATABASE", "agno_wfm")
    password = os.getenv(password_env, default_password)
    return f"postgresql+asyncpg://{username}:{password}@{host}:{port}/{database}"


@pytest_asyncio.fixture
async def app_engine() -> AsyncIterator[AsyncEngine]:
    """Function-scoped, not session-scoped: pytest-asyncio gives each async
    test its own event loop by default, and an `AsyncEngine`'s connection
    pool is bound to whichever loop was running when it was created - a
    session-scoped engine reused across tests in different loops surfaces as
    `InterfaceError: cannot perform operation: another operation is in
    progress` / `RuntimeError: Event loop is closed` on the second test that
    touches it (found by actually running this suite against a real
    Postgres - a session-scoped version of this fixture looked correct and
    passed a smaller test file by coincidence before this was caught)."""
    engine = create_async_engine(_url("agno_forecasting_app", "DB_PASSWORD", "changeme_local_only"))
    yield engine
    await engine.dispose()


@pytest.fixture
def tenant_a_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def tenant_b_id() -> uuid.UUID:
    return uuid.uuid4()


@dataclass
class FakeTrainingController:
    """Lets a test pin exactly what `ray_orchestrator.train_candidates_in_parallel`
    returns per model type, so promotion/failure-handling logic in
    `training_service.retrain` can be exercised deterministically without a
    real Ray cluster or model fit."""

    results: dict[str, TrainingResult | TrainingFailure] = field(default_factory=dict)

    def set_result(self, model_type: str, *, mape: float, wfa: float) -> None:
        self.results[model_type] = TrainingResult(
            model_type=model_type,
            backtest_mape=mape,
            backtest_wfa=wfa,
            fitted_model=pickle.dumps(f"fake-fitted-model-{model_type}"),
            training_data_window_start=datetime(2026, 1, 1, tzinfo=UTC),
            training_data_window_end=datetime(2026, 3, 1, tzinfo=UTC),
        )

    def set_failure(self, model_type: str, error: str) -> None:
        self.results[model_type] = TrainingFailure(model_type=model_type, error=error)


@pytest.fixture
def fake_ml_backends(monkeypatch: pytest.MonkeyPatch) -> FakeTrainingController:
    """Injects fake `app.services.ray_orchestrator`/`app.services.mlflow_registry`
    modules into `sys.modules` *before* `training_service.retrain`'s lazy
    `from app.services import ...` executes, so these tests exercise the
    orchestration logic (gate evaluation, promotion, failure isolation)
    deterministically without needing a live Ray cluster or MLflow tracking
    store reachable in CI/local dev - not a Python-version workaround (Ray
    and MLflow both install and run for real on this project's actual
    Python 3.11/3.12 target; see `test_ray_orchestrator_smoke.py` for tests
    against the real thing)."""
    controller = FakeTrainingController()

    def fake_train_candidates_in_parallel(
        candidates: list[tuple[str, object, int, object]],
    ) -> list[TrainingResult | TrainingFailure]:
        results: list[TrainingResult | TrainingFailure] = []
        for model_type, _series, _holdout_periods, _holidays in candidates:
            if model_type in controller.results:
                results.append(controller.results[model_type])
            else:
                results.append(TrainingResult(
                    model_type=model_type,
                    backtest_mape=10.0,
                    backtest_wfa=90.0,
                    fitted_model=pickle.dumps(f"fake-fitted-model-{model_type}"),
                    training_data_window_start=datetime(2026, 1, 1, tzinfo=UTC),
                    training_data_window_end=datetime(2026, 3, 1, tzinfo=UTC),
                ))
        return results

    def fake_log_model(result: TrainingResult, **_kwargs: object) -> str:
        return f"file:///fake-mlruns/{result.model_type}"

    def fake_load_model(artifact_uri: str) -> object:
        """Real `mlflow_registry.load_model` returns whatever
        `fitted_model` was originally pickled - since these tests never run
        real training, this fakes an equivalent by fitting a tiny real
        model fresh (statsmodels/prophet themselves *are* installed in this
        sandbox, unlike ray/mlflow), so `inference_service.run_inference`
        exercises real `.forecast()`/`.predict()` calls rather than a mock
        with no genuine forecasting behavior."""
        import pandas as pd

        model_type = artifact_uri.rsplit("/", 1)[-1]
        index = pd.date_range("2026-01-01", periods=24 * 14, freq="h")
        series = pd.Series(10.0, index=index)
        if model_type == "sarima":
            from app.ml.sarima import fit_sarima

            return fit_sarima(series, order=(1, 0, 0), seasonal_order=(0, 0, 0, 0))
        if model_type == "prophet":
            from app.ml.prophet_model import fit_prophet

            return fit_prophet(series)
        if model_type == "lightgbm":
            from app.ml.lightgbm_model import fit_lightgbm

            return fit_lightgbm(series)
        raise ValueError(f"fake_load_model has no fixture model for model_type={model_type!r}")

    fake_ray_orchestrator = types.ModuleType("app.services.ray_orchestrator")
    fake_ray_orchestrator.train_candidates_in_parallel = fake_train_candidates_in_parallel  # type: ignore[attr-defined]
    fake_mlflow_registry = types.ModuleType("app.services.mlflow_registry")
    fake_mlflow_registry.log_model = fake_log_model  # type: ignore[attr-defined]
    fake_mlflow_registry.load_model = fake_load_model  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "app.services.ray_orchestrator", fake_ray_orchestrator)
    monkeypatch.setitem(sys.modules, "app.services.mlflow_registry", fake_mlflow_registry)

    return controller
