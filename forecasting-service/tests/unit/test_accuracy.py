"""ADR-0025, Decision 2: pure per-interval MAPE/bias math, no DB."""

from __future__ import annotations

import pytest

from app.ml.accuracy import interval_bias, interval_mape


def test_interval_mape_is_zero_for_a_perfect_prediction() -> None:
    assert interval_mape(100.0, 100.0) == pytest.approx(0.0)


def test_interval_mape_matches_hand_computed_value() -> None:
    # |100-110|/100 * 100 = 10%
    assert interval_mape(100.0, 110.0) == pytest.approx(10.0)


def test_interval_mape_is_none_when_actual_is_zero() -> None:
    assert interval_mape(0.0, 5.0) is None


def test_interval_bias_is_positive_when_over_forecast() -> None:
    # (110-100)/100 * 100 = +10%
    assert interval_bias(100.0, 110.0) == pytest.approx(10.0)


def test_interval_bias_is_negative_when_under_forecast() -> None:
    # (90-100)/100 * 100 = -10%
    assert interval_bias(100.0, 90.0) == pytest.approx(-10.0)


def test_interval_bias_is_zero_for_a_perfect_prediction() -> None:
    assert interval_bias(50.0, 50.0) == pytest.approx(0.0)


def test_interval_bias_is_none_when_actual_is_zero() -> None:
    assert interval_bias(0.0, 5.0) is None
