"""Pure similarity-scoring/bucketing/averaging logic - no DB required."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from app.services.cold_start_service import (
    QueueProfileFeatures,
    average_samples,
    similarity_score,
    time_of_week_bucket,
)


def test_identical_profiles_score_maximally() -> None:
    profile = QueueProfileFeatures(
        industry="retail", queue_type="inbound_support", expected_volume_band="m", timezone_bucket="utc-5"
    )
    assert similarity_score(profile, profile) == 4.0


def test_completely_different_profiles_score_at_or_near_zero() -> None:
    a = QueueProfileFeatures(
        industry="retail", queue_type="inbound_support", expected_volume_band="xs", timezone_bucket="utc-5"
    )
    b = QueueProfileFeatures(
        industry="healthcare", queue_type="billing", expected_volume_band="xl", timezone_bucket="utc+1"
    )
    assert similarity_score(a, b) == 0.0


def test_adjacent_volume_bands_score_higher_than_distant_ones() -> None:
    target = QueueProfileFeatures(
        industry="retail", queue_type="sales", expected_volume_band="m", timezone_bucket="utc-5"
    )
    adjacent = QueueProfileFeatures(
        industry="other", queue_type="other", expected_volume_band="l", timezone_bucket="other"
    )
    distant = QueueProfileFeatures(
        industry="other", queue_type="other", expected_volume_band="xs", timezone_bucket="other"
    )
    assert similarity_score(adjacent, target) > similarity_score(distant, target)


def test_time_of_week_bucket_groups_same_weekday_and_slot() -> None:
    monday_9am = datetime(2026, 1, 5, 9, 0, tzinfo=UTC)  # a Monday
    monday_9_15am = datetime(2026, 1, 5, 9, 15, tzinfo=UTC)
    tuesday_9am = datetime(2026, 1, 6, 9, 0, tzinfo=UTC)

    assert time_of_week_bucket(monday_9am, 30) == time_of_week_bucket(monday_9_15am, 30)
    assert time_of_week_bucket(monday_9am, 30) != time_of_week_bucket(tuesday_9am, 30)


def test_average_samples_ignores_none_per_column_independently() -> None:
    samples = [
        (Decimal(10), Decimal(300), None),
        (Decimal(20), None, Decimal("0.1")),
        (None, Decimal(200), Decimal("0.2")),
    ]
    volume_avg, aht_avg, shrinkage_avg = average_samples(samples)
    assert volume_avg == Decimal(15)
    assert aht_avg == Decimal(250)
    assert shrinkage_avg == Decimal("0.15")


def test_average_samples_of_empty_list_is_all_none() -> None:
    assert average_samples([]) == (None, None, None)
