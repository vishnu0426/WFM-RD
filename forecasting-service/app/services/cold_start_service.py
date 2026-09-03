"""§2.3's cold-start fallback: same-tenant similarity matching + forecast
seeding, per ADR-0019's defaults and ADR-0020's storage/scope decisions.
Cross-tenant matching is deliberately not implemented here - `tenant_settings.
cold_start_cross_tenant_matching_enabled` exists and is checked nowhere in
this module yet, per ADR-0019's own pre-declared Phase 2 scope boundary.

Split, same as `data_quality_service`, into pure functions (similarity
scoring, time-of-week bucketing, averaging - unit-testable with no DB) and
DB-backed orchestration.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ForecastDataPoint, HistoricalActual, QueueProfile
from app.services import headcount_service

# ADR-0019: N=5 neighbors.
MAX_DONORS = 5
# A donor doesn't need to pass the full DataQualityCheck gate (it's not
# itself being trained on) - just have enough of a track record to be a
# useful seed. Deliberately loose, stated heuristics (ADR-0020).
MIN_DONOR_WEEKS = 2.0
MIN_DONOR_ROWS = 20
# How far back to pull donor actuals from when averaging a seed forecast.
DONOR_LOOKBACK_WEEKS = 8
_WEEK_SECONDS = 7 * 24 * 60 * 60
_CONFIDENCE_BAND = Decimal("0.20")


@dataclass(frozen=True)
class QueueProfileFeatures:
    industry: str
    queue_type: str
    expected_volume_band: str
    timezone_bucket: str


_VOLUME_BAND_ORDER = ("xs", "s", "m", "l", "xl")


def similarity_score(candidate: QueueProfileFeatures, target: QueueProfileFeatures) -> float:
    """Pure scoring, no DB access. Categorical exact-match dimensions are
    weighted equally (industry, queue type, timezone bucket); volume band
    contributes a distance-scaled partial score rather than all-or-nothing,
    since "one band off" is a meaningfully closer match than "four bands
    off." Not a validated statistical similarity measure - a stated
    heuristic (ADR-0020), revisit once Phase 7 accuracy data exists to
    judge cold-start seed quality against."""
    score = 0.0
    if candidate.industry == target.industry:
        score += 1.0
    if candidate.queue_type == target.queue_type:
        score += 1.0
    if candidate.timezone_bucket == target.timezone_bucket:
        score += 1.0

    try:
        candidate_idx = _VOLUME_BAND_ORDER.index(candidate.expected_volume_band)
        target_idx = _VOLUME_BAND_ORDER.index(target.expected_volume_band)
        distance = abs(candidate_idx - target_idx)
        score += max(1.0 - (distance / (len(_VOLUME_BAND_ORDER) - 1)), 0.0)
    except ValueError:
        pass

    return score


def time_of_week_bucket(moment: datetime, interval_minutes: int) -> tuple[int, int]:
    """`(weekday, interval-of-day index)` - the key cold-start seeding
    averages donor actuals by. Pure function."""
    minute_of_day = moment.hour * 60 + moment.minute
    return moment.weekday(), minute_of_day // interval_minutes


def average_samples(
    samples: list[tuple[Decimal | None, Decimal | None, Decimal | None]],
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """Pure function: per-column average over `(volume, aht, shrinkage)`
    tuples, ignoring `None`s column-wise. Empty/all-`None` input yields
    `(None, None, None)`."""

    def _avg(values: list[Decimal]) -> Decimal | None:
        if not values:
            return None
        return sum(values, Decimal(0)) / len(values)

    volumes = [v for v, _, _ in samples if v is not None]
    ahts = [a for _, a, _ in samples if a is not None]
    shrinkages = [s for _, _, s in samples if s is not None]
    return _avg(volumes), _avg(ahts), _avg(shrinkages)


async def select_similar_queues(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    target_org_unit_id: uuid.UUID,
    as_of: datetime | None = None,
) -> list[uuid.UUID]:
    as_of = as_of or datetime.now(UTC)

    target_profile = await session.scalar(
        select(QueueProfile).where(
            QueueProfile.tenant_id == tenant_id, QueueProfile.org_unit_id == target_org_unit_id
        )
    )
    if target_profile is None:
        # No profile means nothing to score similarity against - cold start
        # can't select donors, not a crash. The caller (job_service) treats
        # an empty donor list the same as "no eligible donors found."
        return []
    target_features = QueueProfileFeatures(
        industry=target_profile.industry,
        queue_type=target_profile.queue_type,
        expected_volume_band=target_profile.expected_volume_band,
        timezone_bucket=target_profile.timezone_bucket,
    )

    candidates = (
        await session.scalars(
            select(QueueProfile).where(
                QueueProfile.tenant_id == tenant_id,
                QueueProfile.org_unit_id != target_org_unit_id,
            )
        )
    ).all()

    scored: list[tuple[float, uuid.UUID]] = []
    for candidate in candidates:
        if not await _is_eligible_donor(session, tenant_id, candidate.org_unit_id, as_of):
            continue
        candidate_features = QueueProfileFeatures(
            industry=candidate.industry,
            queue_type=candidate.queue_type,
            expected_volume_band=candidate.expected_volume_band,
            timezone_bucket=candidate.timezone_bucket,
        )
        scored.append((similarity_score(candidate_features, target_features), candidate.org_unit_id))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [org_unit_id for _, org_unit_id in scored[:MAX_DONORS]]


async def _is_eligible_donor(
    session: AsyncSession, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, as_of: datetime
) -> bool:
    earliest = await session.scalar(
        select(func.min(HistoricalActual.interval_start)).where(
            HistoricalActual.tenant_id == tenant_id, HistoricalActual.org_unit_id == org_unit_id
        )
    )
    if earliest is None:
        return False
    weeks_available = (as_of - earliest).total_seconds() / _WEEK_SECONDS
    if weeks_available < MIN_DONOR_WEEKS:
        return False

    row_count = await session.scalar(
        select(func.count()).where(
            HistoricalActual.tenant_id == tenant_id, HistoricalActual.org_unit_id == org_unit_id
        )
    )
    return bool(row_count and row_count >= MIN_DONOR_ROWS)


async def seed_cold_start_forecast(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    forecast_run_id: uuid.UUID,
    donor_org_unit_ids: list[uuid.UUID],
    date_range_start: date,
    date_range_end: date,
    interval_minutes: int,
    as_of: datetime | None = None,
) -> int:
    """Averages donor queues' actuals by time-of-week bucket over the last
    `DONOR_LOOKBACK_WEEKS` and writes one `ForecastDataPoint` per requested
    interval. Confidence band is a flat +/-20% heuristic (ADR-0020) - not a
    statistical interval, a stated placeholder pending Phase 7 accuracy data.
    `required_headcount` (Phase 5, ADR-0023) is computed against `org_unit_id`
    (the target queue), not the donors - its own `service_level_targets`/
    historical AHT-shrinkage fallback apply, not the donors'. Returns the
    number of `ForecastDataPoint` rows written."""
    as_of = as_of or datetime.now(UTC)
    headcount_context = await headcount_service.build_headcount_context(
        session, tenant_id=tenant_id, org_unit_id=org_unit_id
    )
    lookback_start = as_of - timedelta(weeks=DONOR_LOOKBACK_WEEKS)

    rows = (
        await session.execute(
            select(
                HistoricalActual.interval_start,
                HistoricalActual.actual_volume,
                HistoricalActual.actual_aht_seconds,
                HistoricalActual.actual_shrinkage_pct,
            ).where(
                HistoricalActual.tenant_id == tenant_id,
                HistoricalActual.org_unit_id.in_(donor_org_unit_ids),
                HistoricalActual.interval_start >= lookback_start,
                HistoricalActual.interval_start < as_of,
            )
        )
    ).all()

    buckets: dict[tuple[int, int], list[tuple[Decimal | None, Decimal | None, Decimal | None]]] = (
        defaultdict(list)
    )
    for interval_start, volume, aht, shrinkage in rows:
        buckets[time_of_week_bucket(interval_start, interval_minutes)].append((volume, aht, shrinkage))

    now = datetime.now(UTC)
    cursor = datetime.combine(date_range_start, time.min, tzinfo=UTC)
    end = datetime.combine(date_range_end, time.min, tzinfo=UTC) + timedelta(days=1)
    step = timedelta(minutes=interval_minutes)

    created = 0
    while cursor < end:
        samples = buckets.get(time_of_week_bucket(cursor, interval_minutes), [])
        volume_avg, aht_avg, shrinkage_avg = average_samples(samples)
        session.add(
            ForecastDataPoint(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                forecast_run_id=forecast_run_id,
                interval_start=cursor,
                predicted_volume=volume_avg,
                predicted_aht_seconds=aht_avg,
                predicted_shrinkage_pct=shrinkage_avg,
                confidence_lower=volume_avg * (1 - _CONFIDENCE_BAND) if volume_avg is not None else None,
                confidence_upper=volume_avg * (1 + _CONFIDENCE_BAND) if volume_avg is not None else None,
                required_headcount=headcount_service.compute_required_headcount(
                    predicted_volume=volume_avg,
                    predicted_aht_seconds=aht_avg,
                    predicted_shrinkage_pct=shrinkage_avg,
                    interval_minutes=interval_minutes,
                    context=headcount_context,
                ),
                created_at=now,
            )
        )
        created += 1
        cursor += step

    await session.flush()
    return created
