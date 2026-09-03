"""`training_service.retrain`'s orchestration logic - the data-quality gate,
the quality-gated promotion rule (ADR-0022, Decision 3: a fresh candidate
only unseats the current `active` model by clearing a minimum relative
improvement margin, not just by being the best of this batch), and
per-model failure isolation - against a real Postgres with real
`historical_actuals`, but `ray_orchestrator`/`mlflow_registry` faked out
(`fake_ml_backends`, `tests/integration/conftest.py`) to keep these DB-heavy
tests fast/deterministic (Ray and MLflow themselves install and run for
real - see `tests/unit/test_ray_orchestrator_smoke.py`).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.tenant_context import TenantContext
from app.db.models import ForecastModel, HistoricalActual
from app.db.session import tenant_scoped_session
from app.services import training_service
from tests.integration.conftest import FakeTrainingController

pytestmark = pytest.mark.asyncio

_INTERVAL_MINUTES = 30


async def _seed_actuals(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, weeks: int
) -> None:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    as_of = datetime.now(UTC)
    total_intervals = weeks * 7 * 24 * 60 // _INTERVAL_MINUTES
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        for i in range(total_intervals):
            interval_start = as_of - timedelta(minutes=_INTERVAL_MINUTES * (total_intervals - i))
            session.add(
                HistoricalActual(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    org_unit_id=org_unit_id,
                    interval_start=interval_start,
                    actual_volume=10,
                    actual_aht_seconds=300,
                    actual_shrinkage_pct="0.15",
                    created_at=as_of,
                )
            )
        await session.flush()


async def _get_active(
    app_engine: AsyncEngine, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> list[ForecastModel]:
    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_id)), session_factory=factory
    ) as session:
        return list(
            (
                await session.scalars(
                    select(ForecastModel).where(
                        ForecastModel.tenant_id == tenant_id,
                        ForecastModel.org_unit_id == org_unit_id,
                        ForecastModel.status == "active",
                    )
                )
            ).all()
        )


async def test_retrain_promotes_the_lower_mape_candidate_when_no_active_model_exists(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)
    fake_ml_backends.set_result("sarima", mape=8.0, wfa=92.0)
    fake_ml_backends.set_result("prophet", mape=4.0, wfa=96.0)
    fake_ml_backends.set_result("lightgbm", mape=9.0, wfa=91.0)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )

    by_type = {o.model_type: o for o in outcomes}
    assert by_type["sarima"].trained is True
    assert by_type["prophet"].trained is True
    assert by_type["lightgbm"].trained is True
    assert by_type["prophet"].status == "active"  # lowest MAPE (4.0), no active model to beat
    assert by_type["sarima"].status == "deprecated"
    assert by_type["lightgbm"].status == "deprecated"

    active = await _get_active(app_engine, tenant_a_id, org_unit_id)
    assert len(active) == 1
    assert active[0].model_type == "prophet"


async def test_a_later_retrain_promotes_a_challenger_that_clears_the_margin(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)
    factory = async_sessionmaker(app_engine, expire_on_commit=False)

    fake_ml_backends.set_result("sarima", mape=10.0, wfa=90.0)
    fake_ml_backends.set_result("prophet", mape=20.0, wfa=80.0)
    fake_ml_backends.set_result("lightgbm", mape=12.0, wfa=88.0)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        await training_service.retrain(session, tenant_id=tenant_a_id, org_unit_id=org_unit_id)

    # sarima (mape=10.0) is active. Second retrain: prophet's fresh MAPE
    # (3.0) clears the 5% margin against 10.0 (10.0 * 0.95 = 9.5) by a wide
    # margin - should be promoted.
    fake_ml_backends.set_result("sarima", mape=9.8, wfa=85.0)
    fake_ml_backends.set_result("prophet", mape=3.0, wfa=97.0)
    fake_ml_backends.set_result("lightgbm", mape=11.0, wfa=87.0)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )

    by_type = {o.model_type: o for o in outcomes}
    assert by_type["prophet"].status == "active"
    assert by_type["prophet"].reason is None

    active = await _get_active(app_engine, tenant_a_id, org_unit_id)
    assert len(active) == 1
    assert active[0].model_type == "prophet"
    assert active[0].backtest_mape is not None
    assert float(active[0].backtest_mape) == pytest.approx(3.0)


async def test_a_challenger_that_does_not_clear_the_margin_does_not_get_promoted(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    """ADR-0022, Decision 3's actual point: Phase 3's naive rule would have
    promoted any lower-MAPE candidate; the quality-gated rule requires
    clearing a minimum relative improvement over the model already serving,
    and must leave that model untouched (not silently swapped for a
    noise-level-better challenger) when the margin isn't cleared."""
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)
    factory = async_sessionmaker(app_engine, expire_on_commit=False)

    fake_ml_backends.set_result("sarima", mape=10.0, wfa=90.0)
    fake_ml_backends.set_result("prophet", mape=15.0, wfa=85.0)
    fake_ml_backends.set_result("lightgbm", mape=12.0, wfa=88.0)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        first_outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )
    assert {o.model_type: o.status for o in first_outcomes}["sarima"] == "active"

    # Second retrain: sarima's fresh MAPE (9.9) is technically better than
    # the active model's 10.0, but only ~1% - well under the 5% margin.
    fake_ml_backends.set_result("sarima", mape=9.9, wfa=90.1)
    fake_ml_backends.set_result("prophet", mape=15.0, wfa=85.0)
    fake_ml_backends.set_result("lightgbm", mape=12.0, wfa=88.0)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        second_outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )

    by_type = {o.model_type: o for o in second_outcomes}
    assert by_type["sarima"].trained is True
    assert by_type["sarima"].status == "deprecated"  # best of batch, but margin not cleared
    assert by_type["sarima"].reason == "did_not_meet_promotion_margin"

    # The *original* active model (from the first retrain) is still active -
    # untouched, not swapped for the second retrain's fresh (but
    # insufficiently-better) sarima candidate.
    active = await _get_active(app_engine, tenant_a_id, org_unit_id)
    assert len(active) == 1
    assert active[0].model_type == "sarima"
    assert active[0].backtest_mape is not None
    assert float(active[0].backtest_mape) == pytest.approx(10.0)


async def test_a_failed_candidate_gets_a_failed_row_without_sinking_the_batch(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    org_unit_id = uuid.uuid4()
    await _seed_actuals(app_engine, tenant_a_id, org_unit_id, weeks=13)
    fake_ml_backends.set_failure("sarima", "did not converge")
    fake_ml_backends.set_result("prophet", mape=6.0, wfa=94.0)
    fake_ml_backends.set_result("lightgbm", mape=8.0, wfa=92.0)

    factory = async_sessionmaker(app_engine, expire_on_commit=False)
    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )

    by_type = {o.model_type: o for o in outcomes}
    assert by_type["sarima"].trained is False
    assert by_type["sarima"].status == "failed"
    assert "did not converge" in (by_type["sarima"].reason or "")
    assert by_type["prophet"].trained is True
    assert by_type["prophet"].status == "active"
    assert by_type["lightgbm"].trained is True
    assert by_type["lightgbm"].status == "deprecated"


async def test_retrain_reports_insufficient_history_without_training_anything(
    app_engine: AsyncEngine, tenant_a_id: uuid.UUID, fake_ml_backends: FakeTrainingController
) -> None:
    """No `historical_actuals` seeded at all - every candidate (sarima,
    prophet, lightgbm) should fail the gate, and
    `train_candidates_in_parallel` should never be called."""
    org_unit_id = uuid.uuid4()
    factory = async_sessionmaker(app_engine, expire_on_commit=False)

    async with tenant_scoped_session(
        TenantContext(tenant_id=str(tenant_a_id)), session_factory=factory
    ) as session:
        outcomes = await training_service.retrain(
            session, tenant_id=tenant_a_id, org_unit_id=org_unit_id
        )

    assert {o.model_type for o in outcomes} == {"sarima", "prophet", "lightgbm"}
    assert all(o.trained is False for o in outcomes)
    assert all(o.reason == "insufficient_history" for o in outcomes)
