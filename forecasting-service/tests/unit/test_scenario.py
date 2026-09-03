"""`app/ml/scenario.py`'s assumption-override math (ADR-0024) - pure, no DB."""

from __future__ import annotations

import pytest

from app.ml.scenario import AssumptionOverrides, apply_overrides

_NO_OP = AssumptionOverrides()


def test_no_op_overrides_leave_values_unchanged() -> None:
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=_NO_OP)
    assert result.volume == pytest.approx(100.0)
    assert result.aht_seconds == pytest.approx(300.0)
    assert result.shrinkage_pct == pytest.approx(0.2)


def test_volume_multiplier_scales_volume_only() -> None:
    overrides = AssumptionOverrides(volume_multiplier=1.2)
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=overrides)
    assert result.volume == pytest.approx(120.0)
    assert result.aht_seconds == pytest.approx(300.0)
    assert result.shrinkage_pct == pytest.approx(0.2)


def test_zero_volume_multiplier_is_a_legitimate_what_if_queue_closes_scenario() -> None:
    overrides = AssumptionOverrides(volume_multiplier=0.0)
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=overrides)
    assert result.volume == 0.0


def test_aht_delta_is_additive_not_multiplicative() -> None:
    overrides = AssumptionOverrides(aht_delta_seconds=30.0)
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=overrides)
    assert result.aht_seconds == pytest.approx(330.0)


def test_aht_delta_cannot_push_aht_to_zero_or_below() -> None:
    overrides = AssumptionOverrides(aht_delta_seconds=-1000.0)
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=overrides)
    assert result.aht_seconds is not None
    assert result.aht_seconds > 0


def test_shrinkage_delta_is_additive_and_clamped_to_valid_range() -> None:
    high = apply_overrides(
        volume=100.0,
        aht_seconds=300.0,
        shrinkage_pct=0.9,
        overrides=AssumptionOverrides(shrinkage_delta_pct=0.5),
    )
    assert high.shrinkage_pct is not None
    assert high.shrinkage_pct <= 0.99

    low = apply_overrides(
        volume=100.0,
        aht_seconds=300.0,
        shrinkage_pct=0.1,
        overrides=AssumptionOverrides(shrinkage_delta_pct=-0.5),
    )
    assert low.shrinkage_pct is not None
    assert low.shrinkage_pct >= 0.0


def test_none_inputs_stay_none_regardless_of_overrides() -> None:
    overrides = AssumptionOverrides(volume_multiplier=2.0, aht_delta_seconds=50.0, shrinkage_delta_pct=0.1)
    result = apply_overrides(volume=None, aht_seconds=None, shrinkage_pct=None, overrides=overrides)
    assert result.volume is None
    assert result.aht_seconds is None
    assert result.shrinkage_pct is None


def test_volume_cannot_go_negative_even_with_a_negative_edge_case() -> None:
    # volume_multiplier is validated >= 0 at the API layer, but the pure
    # function itself should still never produce a negative volume even if
    # called directly with an out-of-contract value.
    overrides = AssumptionOverrides(volume_multiplier=-1.0)
    result = apply_overrides(volume=100.0, aht_seconds=300.0, shrinkage_pct=0.2, overrides=overrides)
    assert result.volume == 0.0
