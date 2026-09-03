"""Pure ADR-0019 threshold logic - no DB required."""

from __future__ import annotations

from app.services.data_quality_service import evaluate_thresholds


def test_sarima_passes_with_enough_history_and_few_gaps() -> None:
    passed, reason = evaluate_thresholds(
        model_type="sarima",
        weeks_of_history_available=8.5,
        total_expected_intervals=2688,  # 8 weeks * 336 half-hour intervals/week
        missing_intervals=50,  # ~1.9%
        tft_entitled=False,
    )
    assert passed is True
    assert reason is None


def test_sarima_fails_insufficient_history_before_checking_gaps() -> None:
    passed, reason = evaluate_thresholds(
        model_type="sarima",
        weeks_of_history_available=3.0,
        total_expected_intervals=2688,
        missing_intervals=0,
        tft_entitled=False,
    )
    assert passed is False
    assert reason == "insufficient_history"


def test_sarima_fails_excessive_gaps_once_history_bar_is_met() -> None:
    passed, reason = evaluate_thresholds(
        model_type="sarima",
        weeks_of_history_available=10.0,
        total_expected_intervals=2688,
        missing_intervals=300,  # ~11%, over the 5% bar
        tft_entitled=False,
    )
    assert passed is False
    assert reason == "excessive_gaps"


def test_prophet_tolerates_a_gap_ratio_sarima_would_reject() -> None:
    passed, reason = evaluate_thresholds(
        model_type="prophet",
        weeks_of_history_available=12.0,
        total_expected_intervals=4032,  # 12 weeks * 336
        missing_intervals=300,  # ~7.4% - over sarima's 5% bar, under prophet's 10%
        tft_entitled=False,
    )
    assert passed is True
    assert reason is None


def test_tft_fails_missing_entitlement_even_with_ample_data() -> None:
    passed, reason = evaluate_thresholds(
        model_type="tft",
        weeks_of_history_available=52.0,
        total_expected_intervals=100_000,
        missing_intervals=0,
        tft_entitled=False,
    )
    assert passed is False
    assert reason == "missing_tft_entitlement"


def test_tft_passes_with_entitlement_and_enough_history() -> None:
    passed, reason = evaluate_thresholds(
        model_type="tft",
        weeks_of_history_available=30.0,
        total_expected_intervals=100_000,
        missing_intervals=100,
        tft_entitled=True,
    )
    assert passed is True
    assert reason is None


def test_zero_expected_intervals_is_treated_as_total_gap() -> None:
    """Guards the division-by-zero path: no expected intervals at all reads
    as 100% missing, not as an automatic pass."""
    passed, reason = evaluate_thresholds(
        model_type="sarima",
        weeks_of_history_available=8.0,
        total_expected_intervals=0,
        missing_intervals=0,
        tft_entitled=False,
    )
    assert passed is False
    assert reason == "excessive_gaps"
