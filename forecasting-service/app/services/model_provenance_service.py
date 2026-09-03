"""ADR-0026, Decision 6 - the REST audit-trail/explainability endpoint §3.2's
`forecastModelProvenance` never got in this repo (Phase 1 pushed the
GraphQL version of that field to Node/Module 01). Reads back what
ADR-0021 Decision 3 already retains (deprecated/failed `ForecastModel`
rows are never deleted) plus, for a `lightgbm` active model only, real
feature importances off its persisted `Booster`.
"""

from __future__ import annotations

from typing import Any

from app.db.models import ForecastModel


def load_lightgbm_feature_importances(fitted: Any) -> list[tuple[str, float]]:
    """`fitted` is `mlflow_registry.load_model`'s return value for a
    `lightgbm` artifact - `dict[str, lgb.Booster]` (`app/ml/lightgbm_model.py`,
    keys `lower`/`point`/`upper`). Only the `point` (median) booster's
    importances are surfaced - the two quantile boosters exist for interval
    width, not a second opinion on feature relevance."""
    booster = fitted["point"]
    names = booster.feature_name()
    importances = booster.feature_importance().tolist()
    return list(zip(names, importances, strict=True))


def find_active(history: list[ForecastModel]) -> ForecastModel | None:
    return next((model for model in history if model.status == "active"), None)
