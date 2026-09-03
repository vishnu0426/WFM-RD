"""Erlang C headcount conversion - DB-aware wrapper around `app/ml/erlang.py`
(ADR-0023). Split into a once-per-run async lookup (`build_headcount_context`
- service level target + the historical-shrinkage fallback, both resolved
once, not once per interval) and a pure per-interval function
(`compute_required_headcount` - no DB access, safe and cheap to call once
per `ForecastDataPoint`, independently unit-testable).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import HistoricalActual, ServiceLevelTarget
from app.ml.erlang import required_headcount as _required_headcount

# ADR-0023, Decision 3: platform defaults used whenever a tenant hasn't
# configured `service_level_targets` for an org unit - the industry-
# conventional "80/20 rule" plus a standard occupancy ceiling.
DEFAULT_TARGET_SERVICE_LEVEL = 0.80
DEFAULT_TARGET_ANSWER_TIME_SECONDS = 20
DEFAULT_MAX_OCCUPANCY = 0.85
# ADR-0023, Decision 4: the last-resort shrinkage fallback - a commonly
# cited contact-center ballpark, not a tuned or validated number.
DEFAULT_SHRINKAGE = 0.30
SHRINKAGE_LOOKBACK_WEEKS = 8


@dataclass(frozen=True)
class ServiceLevelTargetConfig:
    target_service_level: float
    target_answer_time_seconds: int
    max_occupancy: float


@dataclass(frozen=True)
class HeadcountContext:
    """Resolved once per forecast run/retrain call - never once per
    interval, which would mean an interval-count N+1 query pattern.
    `fallback_aht_seconds` is nullable (unlike `fallback_shrinkage`, which
    always resolves to at least the platform default): AHT has no
    defensible universal fallback the way a ballpark shrinkage percentage
    does (a support chat's AHT and a technical-support call's AHT are not
    remotely comparable), so a queue with no historical AHT at all simply
    can't get a computed `required_headcount` - `None`, not a guess."""

    target: ServiceLevelTargetConfig
    fallback_shrinkage: float
    fallback_aht_seconds: float | None


async def get_service_level_target(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> ServiceLevelTargetConfig:
    row = await session.scalar(
        select(ServiceLevelTarget).where(
            ServiceLevelTarget.tenant_id == tenant_id,
            ServiceLevelTarget.org_unit_id == org_unit_id,
        )
    )
    if row is None:
        return ServiceLevelTargetConfig(
            target_service_level=DEFAULT_TARGET_SERVICE_LEVEL,
            target_answer_time_seconds=DEFAULT_TARGET_ANSWER_TIME_SECONDS,
            max_occupancy=DEFAULT_MAX_OCCUPANCY,
        )
    return ServiceLevelTargetConfig(
        target_service_level=float(row.target_service_level),
        target_answer_time_seconds=row.target_answer_time_seconds,
        max_occupancy=float(row.max_occupancy),
    )


async def get_average_shrinkage(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    as_of: datetime | None = None,
) -> float | None:
    as_of = as_of or datetime.now(UTC)
    lookback_start = as_of - timedelta(weeks=SHRINKAGE_LOOKBACK_WEEKS)
    average = await session.scalar(
        select(func.avg(HistoricalActual.actual_shrinkage_pct)).where(
            HistoricalActual.tenant_id == tenant_id,
            HistoricalActual.org_unit_id == org_unit_id,
            HistoricalActual.interval_start >= lookback_start,
            HistoricalActual.interval_start < as_of,
            HistoricalActual.actual_shrinkage_pct.is_not(None),
        )
    )
    return float(average) if average is not None else None


async def get_average_aht_seconds(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    as_of: datetime | None = None,
) -> float | None:
    as_of = as_of or datetime.now(UTC)
    lookback_start = as_of - timedelta(weeks=SHRINKAGE_LOOKBACK_WEEKS)
    average = await session.scalar(
        select(func.avg(HistoricalActual.actual_aht_seconds)).where(
            HistoricalActual.tenant_id == tenant_id,
            HistoricalActual.org_unit_id == org_unit_id,
            HistoricalActual.interval_start >= lookback_start,
            HistoricalActual.interval_start < as_of,
            HistoricalActual.actual_aht_seconds.is_not(None),
        )
    )
    return float(average) if average is not None else None


async def build_headcount_context(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID
) -> HeadcountContext:
    target = await get_service_level_target(session, tenant_id=tenant_id, org_unit_id=org_unit_id)
    historical_shrinkage = await get_average_shrinkage(session, tenant_id=tenant_id, org_unit_id=org_unit_id)
    historical_aht = await get_average_aht_seconds(session, tenant_id=tenant_id, org_unit_id=org_unit_id)
    return HeadcountContext(
        target=target,
        fallback_shrinkage=historical_shrinkage if historical_shrinkage is not None else DEFAULT_SHRINKAGE,
        fallback_aht_seconds=historical_aht,
    )


def compute_required_headcount(
    *,
    predicted_volume: Decimal | float | None,
    predicted_aht_seconds: Decimal | float | None,
    predicted_shrinkage_pct: Decimal | float | None,
    interval_minutes: int,
    context: HeadcountContext,
) -> Decimal | None:
    """Pure - no DB access. Per-interval `predicted_aht_seconds`/
    `predicted_shrinkage_pct` win when populated (cold-start-seeded points);
    otherwise fall back to `context`'s once-per-run resolved values
    (ADR-0023, Decision 4). Returns `None` if volume is missing, or if AHT
    is missing with no historical fallback available either - a queue with
    no AHT data anywhere simply can't get a computed headcount."""
    if predicted_volume is None:
        return None

    aht_seconds = (
        float(predicted_aht_seconds) if predicted_aht_seconds is not None else context.fallback_aht_seconds
    )
    if aht_seconds is None:
        return None

    shrinkage = (
        float(predicted_shrinkage_pct)
        if predicted_shrinkage_pct is not None
        else context.fallback_shrinkage
    )
    headcount = _required_headcount(
        volume=float(predicted_volume),
        aht_seconds=aht_seconds,
        shrinkage=shrinkage,
        interval_seconds=interval_minutes * 60,
        target_service_level=context.target.target_service_level,
        target_answer_seconds=context.target.target_answer_time_seconds,
        max_occupancy=context.target.max_occupancy,
    )
    return None if headcount is None else Decimal(str(round(headcount, 4)))
