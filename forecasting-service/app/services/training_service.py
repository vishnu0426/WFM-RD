"""§3.3's `POST /v1/forecasting/models/{orgUnitId}/retrain` - orchestrates
the data-quality gate, parallel SARIMA/Prophet/LightGBM training
(`ray_orchestrator`), MLflow logging (`mlflow_registry`), and the
quality-gated promotion mechanism §0.5 requires (ADR-0022, Decision 3):
a freshly trained candidate becomes `active` only if no `active` model
exists yet for this `(org_unit_id, target_metric)`, or its `backtest_mape`
beats the *currently active* model's stored `backtest_mape` by at least
`MIN_RELATIVE_IMPROVEMENT` - not just "better than this batch's other
candidates" (Phase 3's naive rule, ADR-0021 Decision 3, now replaced).

`ray.get()` and MLflow's file I/O are both blocking, synchronous calls with
no `await` of their own - run directly inside this `async def`, either one
would freeze the whole process's event loop (every other tenant's concurrent
request, not just this one) for up to the full ~2-minute training budget.
Both are dispatched via `asyncio.to_thread` so the event loop stays free
while they run.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pandas as pd
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import TftEntitlementMissingError
from app.db.models import ForecastModel, HistoricalActual, TenantSettings
from app.ml.backtest import to_float_series
from app.ml.training import TrainingFailure, TrainingResult
from app.services import data_quality_service, special_event_service
from app.services.data_quality_service import THRESHOLDS

CANDIDATE_MODEL_TYPES = ("sarima", "prophet", "lightgbm")
TRAINING_LOOKBACK_WEEKS = 8
HOLDOUT_WEEKS = 2
# ADR-0025, Decision 5. `retrain` has no explicit forecast-horizon parameter
# (that's chosen later, per job, via `POST /v1/forecasting/jobs`) - a stated
# forward margin so holiday tagging survives typical near-term forecast
# requests against a model trained today, without waiting on a real horizon
# input this endpoint doesn't have.
HOLIDAY_FORWARD_MARGIN_DAYS = 180
# ADR-0022, Decision 3. A stated default, not a statistically derived
# significance threshold - see the ADR for why (no same-holdout-window
# paired comparison infrastructure exists yet).
MIN_RELATIVE_IMPROVEMENT = 0.05


@dataclass(frozen=True)
class RetrainOutcome:
    model_type: str
    trained: bool
    reason: str | None
    forecast_model_id: uuid.UUID | None
    backtest_mape: float | None
    backtest_wfa: float | None
    status: str | None


def decide_promotion_winner(
    candidates: list[tuple[uuid.UUID, float]],
    *,
    active_mape: float | None,
    min_relative_improvement: float = MIN_RELATIVE_IMPROVEMENT,
) -> uuid.UUID | None:
    """Pure ADR-0022 Decision 3 logic, no DB access. `candidates` is
    `(forecast_model_id, backtest_mape)` for this retrain call's
    successfully trained models. Returns the id that should become `active`,
    or `None` if nothing should be promoted (an existing `active` model, if
    any, is left untouched - never silently swapped for a challenger that
    didn't clear the margin)."""
    if not candidates:
        return None
    winner_id, winner_mape = min(candidates, key=lambda pair: pair[1])
    if active_mape is None:
        return winner_id
    if winner_mape <= active_mape * (1 - min_relative_improvement):
        return winner_id
    return None


async def retrain(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    target_metric: str = "volume",
    interval_minutes: int = 30,
    model_types: Sequence[str] | None = None,
) -> list[RetrainOutcome]:
    """`model_types` defaults to `CANDIDATE_MODEL_TYPES` (sarima/prophet/
    lightgbm, unconditionally, unchanged from every phase before this one).
    `tft` is never attempted unless a caller explicitly asks for it
    (ADR-0026, Decision 1) - and doing so without the tenant's
    `TenantSettings.tft_entitled` flag set raises `TftEntitlementMissingError`
    (403) immediately, before the data-quality gate even runs (ADR-0026,
    Decision 5; ADR-0019's own stated requirement that entitlement is
    "checked before a `tft` training job is queued at all")."""
    from app.ml.prophet_model import build_holidays_frame  # lazy - ADR-0021 Decision 5
    from app.services import mlflow_registry, ray_orchestrator  # lazy - ADR-0021 Decision 5

    requested_model_types: tuple[str, ...] = tuple(model_types) if model_types else CANDIDATE_MODEL_TYPES

    if "tft" in requested_model_types:
        settings_row = await session.scalar(
            select(TenantSettings).where(TenantSettings.tenant_id == tenant_id)
        )
        if not (settings_row and settings_row.tft_entitled):
            raise TftEntitlementMissingError(str(tenant_id))

    as_of = datetime.now(UTC)
    outcomes: list[RetrainOutcome] = []
    eligible_model_types: list[str] = []

    for model_type in requested_model_types:
        check = await data_quality_service.evaluate_gate(
            session,
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            model_type=model_type,
            target_metric=target_metric,
            interval_minutes=interval_minutes,
        )
        if check.passed:
            eligible_model_types.append(model_type)
        else:
            outcomes.append(
                RetrainOutcome(model_type, False, check.failure_reason, None, None, None, None)
            )

    if not eligible_model_types:
        return outcomes

    # Looked up before training, not after - Decision 3's margin check needs
    # to compare fresh candidates against whatever was active *before* this
    # call, never against a value this same call might otherwise mutate.
    active_model = await get_active_model(
        session, tenant_id=tenant_id, org_unit_id=org_unit_id, target_metric=target_metric
    )
    active_mape = (
        float(active_model.backtest_mape)
        if active_model is not None and active_model.backtest_mape is not None
        else None
    )

    # Scales to whichever eligible candidate needs the most history - `tft`'s
    # 26-week gate threshold (ADR-0019) would otherwise pass the gate (which
    # queries the full history independently) but then get trained on only
    # `TRAINING_LOOKBACK_WEEKS` (8) worth of actuals, defeating the point of
    # the higher bar.
    lookback_weeks = max(TRAINING_LOOKBACK_WEEKS, *(THRESHOLDS[mt].min_weeks for mt in eligible_model_types))
    lookback_start = as_of - timedelta(weeks=lookback_weeks)
    rows = (
        await session.execute(
            select(HistoricalActual.interval_start, HistoricalActual.actual_volume)
            .where(
                HistoricalActual.tenant_id == tenant_id,
                HistoricalActual.org_unit_id == org_unit_id,
                HistoricalActual.interval_start >= lookback_start,
                HistoricalActual.interval_start < as_of,
            )
            .order_by(HistoricalActual.interval_start)
        )
    ).all()
    series = to_float_series([(row.interval_start, row.actual_volume) for row in rows])
    holdout_periods = (HOLDOUT_WEEKS * 7 * 24 * 60) // interval_minutes

    holidays: pd.DataFrame | None = None
    if "prophet" in eligible_model_types:
        holiday_events = await special_event_service.list_holidays_for_training(
            session,
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            window_start=lookback_start.date(),
            window_end=(as_of + timedelta(days=HOLIDAY_FORWARD_MARGIN_DAYS)).date(),
        )
        if holiday_events:
            holidays = build_holidays_frame(
                [
                    (event.event_type, event.date_range_start, event.date_range_end)
                    for event in holiday_events
                ]
            )

    candidates = [
        (model_type, series, holdout_periods, holidays if model_type == "prophet" else None)
        for model_type in eligible_model_types
    ]
    training_results = await asyncio.to_thread(
        ray_orchestrator.train_candidates_in_parallel, candidates
    )

    now = datetime.now(UTC)
    trained: list[tuple[ForecastModel, TrainingResult]] = []
    for result in training_results:
        if isinstance(result, TrainingFailure):
            failed_row = ForecastModel(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                org_unit_id=org_unit_id,
                model_type=result.model_type,
                target_metric=target_metric,
                trained_at=now,
                backtest_mape=None,
                backtest_wfa=None,
                status="failed",
                artifact_uri=None,
                training_data_window_start=None,
                training_data_window_end=None,
                minimum_data_volume_met=True,
                created_at=now,
                updated_at=now,
            )
            session.add(failed_row)
            outcomes.append(
                RetrainOutcome(
                    result.model_type,
                    False,
                    f"training_failed: {result.error}",
                    failed_row.id,
                    None,
                    None,
                    "failed",
                )
            )
            continue

        artifact_uri = await asyncio.to_thread(
            mlflow_registry.log_model,
            result,
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            target_metric=target_metric,
        )
        model_row = ForecastModel(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            org_unit_id=org_unit_id,
            model_type=result.model_type,
            target_metric=target_metric,
            trained_at=now,
            backtest_mape=result.backtest_mape,
            backtest_wfa=result.backtest_wfa,
            status="deprecated",  # promotion decision below may flip the winner to "active"
            artifact_uri=artifact_uri,
            training_data_window_start=result.training_data_window_start,
            training_data_window_end=result.training_data_window_end,
            minimum_data_volume_met=True,
            created_at=now,
            updated_at=now,
        )
        session.add(model_row)
        trained.append((model_row, result))

    scored: list[tuple[uuid.UUID, float]] = [
        (row.id, result.backtest_mape)
        for row, result in trained
        if result.backtest_mape is not None
    ]
    best_of_batch_id = min(scored, key=lambda pair: pair[1])[0] if scored else None
    winner_id = decide_promotion_winner(scored, active_mape=active_mape)

    if winner_id is not None:
        for row, _ in trained:
            if row.id == winner_id:
                row.status = "active"
        if active_model is not None and active_model.id != winner_id:
            await session.execute(
                update(ForecastModel)
                .where(ForecastModel.tenant_id == tenant_id, ForecastModel.id == active_model.id)
                .values(status="deprecated")
            )
        # else: no prior active model, or the prior active model *is* the
        # winner (can't happen today - winners only come from `trained`,
        # freshly created rows - kept as a guard against a future change to
        # `decide_promotion_winner` that might return an existing model's id).

    for row, result in trained:
        if row.id == winner_id:
            status, reason = "active", None
        elif row.id == best_of_batch_id:
            # Best of this batch, but didn't clear Decision 3's margin
            # against the model already serving - a real, visible-to-the-
            # caller distinction from "simply lost to a sibling candidate."
            status, reason = "deprecated", "did_not_meet_promotion_margin"
        else:
            status, reason = "deprecated", None
        outcomes.append(
            RetrainOutcome(
                row.model_type, True, reason, row.id, result.backtest_mape, result.backtest_wfa, status
            )
        )

    await session.flush()
    return outcomes


async def get_active_model(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, target_metric: str
) -> ForecastModel | None:
    model = await session.scalar(
        select(ForecastModel).where(
            ForecastModel.tenant_id == tenant_id,
            ForecastModel.org_unit_id == org_unit_id,
            ForecastModel.target_metric == target_metric,
            ForecastModel.status == "active",
        )
    )
    return model


async def list_models(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> list[ForecastModel]:
    return list(
        (
            await session.scalars(
                select(ForecastModel)
                .where(ForecastModel.tenant_id == tenant_id, ForecastModel.org_unit_id == org_unit_id)
                .order_by(ForecastModel.trained_at.desc())
            )
        ).all()
    )
