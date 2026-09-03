"""`headcount_service.compute_required_headcount` - pure, no DB (the DB-
touching `build_headcount_context`/`get_average_shrinkage`/
`get_average_aht_seconds` are integration-tested against a real Postgres)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.headcount_service import (
    DEFAULT_MAX_OCCUPANCY,
    DEFAULT_SHRINKAGE,
    DEFAULT_TARGET_ANSWER_TIME_SECONDS,
    DEFAULT_TARGET_SERVICE_LEVEL,
    HeadcountContext,
    ServiceLevelTargetConfig,
    compute_required_headcount,
)

_DEFAULT_TARGET = ServiceLevelTargetConfig(
    target_service_level=DEFAULT_TARGET_SERVICE_LEVEL,
    target_answer_time_seconds=DEFAULT_TARGET_ANSWER_TIME_SECONDS,
    max_occupancy=DEFAULT_MAX_OCCUPANCY,
)


def test_returns_none_when_volume_is_missing() -> None:
    context = HeadcountContext(
        target=_DEFAULT_TARGET, fallback_shrinkage=DEFAULT_SHRINKAGE, fallback_aht_seconds=300.0
    )
    result = compute_required_headcount(
        predicted_volume=None,
        predicted_aht_seconds=300,
        predicted_shrinkage_pct=Decimal("0.2"),
        interval_minutes=30,
        context=context,
    )
    assert result is None


def test_returns_none_when_aht_is_missing_and_no_fallback_exists() -> None:
    """ADR-0023, Decision 4: unlike shrinkage, AHT has no platform default -
    a queue with no AHT anywhere simply can't get a computed headcount."""
    context = HeadcountContext(
        target=_DEFAULT_TARGET, fallback_shrinkage=DEFAULT_SHRINKAGE, fallback_aht_seconds=None
    )
    result = compute_required_headcount(
        predicted_volume=100,
        predicted_aht_seconds=None,
        predicted_shrinkage_pct=None,
        interval_minutes=30,
        context=context,
    )
    assert result is None


def test_uses_the_per_interval_aht_and_shrinkage_when_both_are_present() -> None:
    """Cold-start-seeded points carry their own AHT/shrinkage - the context
    fallback must not override them."""
    context = HeadcountContext(target=_DEFAULT_TARGET, fallback_shrinkage=0.99, fallback_aht_seconds=9999.0)
    result = compute_required_headcount(
        predicted_volume=Decimal(100),
        predicted_aht_seconds=Decimal(300),
        predicted_shrinkage_pct=Decimal("0.30"),
        interval_minutes=30,
        context=context,
    )
    # Sanity: matches direct erlang.required_headcount with the same inputs.
    from app.ml.erlang import required_headcount as direct

    expected = direct(
        volume=100.0,
        aht_seconds=300.0,
        shrinkage=0.30,
        interval_seconds=1800,
        target_service_level=DEFAULT_TARGET_SERVICE_LEVEL,
        target_answer_seconds=DEFAULT_TARGET_ANSWER_TIME_SECONDS,
        max_occupancy=DEFAULT_MAX_OCCUPANCY,
    )
    assert result is not None and expected is not None
    assert float(result) == pytest.approx(expected, rel=1e-4)


def test_falls_back_to_context_aht_and_shrinkage_when_interval_lacks_them() -> None:
    """The common model-fulfilled case: predicted_aht_seconds/
    predicted_shrinkage_pct are both None on the ForecastDataPoint, so the
    once-per-run historical fallback in `context` is what actually gets
    used."""
    context = HeadcountContext(target=_DEFAULT_TARGET, fallback_shrinkage=0.25, fallback_aht_seconds=280.0)
    result = compute_required_headcount(
        predicted_volume=Decimal(100),
        predicted_aht_seconds=None,
        predicted_shrinkage_pct=None,
        interval_minutes=30,
        context=context,
    )
    from app.ml.erlang import required_headcount as direct

    expected = direct(
        volume=100.0,
        aht_seconds=280.0,
        shrinkage=0.25,
        interval_seconds=1800,
        target_service_level=DEFAULT_TARGET_SERVICE_LEVEL,
        target_answer_seconds=DEFAULT_TARGET_ANSWER_TIME_SECONDS,
        max_occupancy=DEFAULT_MAX_OCCUPANCY,
    )
    assert result is not None and expected is not None
    assert float(result) == pytest.approx(expected, rel=1e-4)


def test_zero_volume_yields_zero_headcount_not_none() -> None:
    context = HeadcountContext(
        target=_DEFAULT_TARGET, fallback_shrinkage=DEFAULT_SHRINKAGE, fallback_aht_seconds=300.0
    )
    result = compute_required_headcount(
        predicted_volume=Decimal(0),
        predicted_aht_seconds=None,
        predicted_shrinkage_pct=None,
        interval_minutes=30,
        context=context,
    )
    assert result == Decimal("0")
