"""§3.3's model-management endpoints:
`POST /v1/forecasting/models/{orgUnitId}/retrain`,
`GET /v1/forecasting/models/{orgUnitId}`, Phase 7's (ADR-0025)
`GET /v1/forecasting/models/{orgUnitId}/staleness`, and Phase 8's
(ADR-0026) `GET /v1/forecasting/models/{orgUnitId}/provenance`.
"""

from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db_session, get_tenant_context
from app.api.v1.schemas import (
    FeatureImportance,
    ForecastModelResponse,
    ModelProvenanceResponse,
    RetrainOutcomeResponse,
    RetrainRequest,
    RetrainResponse,
    StalenessResponse,
)
from app.core.tenant_context import TenantContext
from app.db.models import ForecastModel
from app.services import accuracy_service, model_provenance_service, training_service

router = APIRouter(prefix="/v1/forecasting/models", tags=["forecasting-models"])


@router.post("/{org_unit_id}/retrain", response_model=RetrainResponse)
async def retrain_models(
    org_unit_id: uuid.UUID,
    body: RetrainRequest,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> RetrainResponse:
    """Synchronous - may take up to ~2 minutes (§0.5's stated SARIMA/Prophet
    SLO), not the fast job-submission-ack path. See ADR-0021, Decision 1."""
    outcomes = await training_service.retrain(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=org_unit_id,
        target_metric=body.target_metric,
        interval_minutes=body.interval_minutes,
        model_types=body.model_types,
    )
    return RetrainResponse(
        org_unit_id=org_unit_id,
        outcomes=[
            RetrainOutcomeResponse(
                model_type=outcome.model_type,
                trained=outcome.trained,
                reason=outcome.reason,
                forecast_model_id=outcome.forecast_model_id,
                backtest_mape=outcome.backtest_mape,
                backtest_wfa=outcome.backtest_wfa,
                status=outcome.status,
            )
            for outcome in outcomes
        ],
    )


def _to_response(model: ForecastModel) -> ForecastModelResponse:
    return ForecastModelResponse(
        id=model.id,
        org_unit_id=model.org_unit_id,
        model_type=model.model_type,
        target_metric=model.target_metric,
        trained_at=model.trained_at,
        backtest_mape=model.backtest_mape,
        backtest_wfa=model.backtest_wfa,
        status=model.status,
        artifact_uri=model.artifact_uri,
        training_data_window_start=model.training_data_window_start,
        training_data_window_end=model.training_data_window_end,
        minimum_data_volume_met=model.minimum_data_volume_met,
    )


@router.get("/{org_unit_id}", response_model=list[ForecastModelResponse])
async def list_forecast_models(
    org_unit_id: uuid.UUID,
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> list[ForecastModelResponse]:
    models = await training_service.list_models(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id
    )
    return [_to_response(model) for model in models]


@router.get("/{org_unit_id}/staleness", response_model=StalenessResponse)
async def get_model_staleness(
    org_unit_id: uuid.UUID,
    target_metric: str = Query(default="volume", pattern="^(volume|aht|shrinkage)$"),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> StalenessResponse:
    result = await accuracy_service.check_staleness(
        session,
        tenant_id=uuid.UUID(context.tenant_id),
        org_unit_id=org_unit_id,
        target_metric=target_metric,
    )
    return StalenessResponse(org_unit_id=org_unit_id, **result.__dict__)


@router.get("/{org_unit_id}/provenance", response_model=ModelProvenanceResponse)
async def get_model_provenance(
    org_unit_id: uuid.UUID,
    target_metric: str = Query(default="volume", pattern="^(volume|aht|shrinkage)$"),
    context: TenantContext = Depends(get_tenant_context),
    session: AsyncSession = Depends(get_db_session),
) -> ModelProvenanceResponse:
    """ADR-0026, Decision 6 - the REST audit trail §3.2's
    `forecastModelProvenance` never had a home in this repo. Every
    `ForecastModel` ever trained for this org unit/target metric (active,
    deprecated, *and* failed - ADR-0021 Decision 3 already retains them
    all), newest first, plus real feature importances for the active
    model when it's `lightgbm` - a stated, named gap for the other three
    model types this phase (see the ADR)."""
    all_models = await training_service.list_models(
        session, tenant_id=uuid.UUID(context.tenant_id), org_unit_id=org_unit_id
    )
    history = [model for model in all_models if model.target_metric == target_metric]
    active_model = model_provenance_service.find_active(history)

    feature_importances: list[FeatureImportance] | None = None
    if active_model is not None and active_model.model_type == "lightgbm" and active_model.artifact_uri:
        from app.services import mlflow_registry  # lazy - ADR-0021 Decision 5

        fitted = await asyncio.to_thread(mlflow_registry.load_model, active_model.artifact_uri)
        pairs = model_provenance_service.load_lightgbm_feature_importances(fitted)
        feature_importances = [FeatureImportance(feature=name, importance=value) for name, value in pairs]

    return ModelProvenanceResponse(
        org_unit_id=org_unit_id,
        target_metric=target_metric,
        active_model_id=active_model.id if active_model is not None else None,
        history=[_to_response(model) for model in history],
        feature_importances=feature_importances,
    )
