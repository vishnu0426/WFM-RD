"""§2.2's gate, split into a pure threshold function (ADR-0019's numbers,
independently unit-testable with no DB) and a DB-backed wrapper that queries
`historical_actuals`/`tenant_settings` and persists a `DataQualityCheck` row.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DataQualityCheck, HistoricalActual, TenantSettings

_WEEK_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class GateThreshold:
    min_weeks: int
    max_gap_ratio: float


# ADR-0019's table. `lightgbm`'s feature-coverage sub-check is not
# implemented in this phase (ADR-0020) - only the volume/gap bar applies.
THRESHOLDS: dict[str, GateThreshold] = {
    "sarima": GateThreshold(min_weeks=8, max_gap_ratio=0.05),
    "prophet": GateThreshold(min_weeks=12, max_gap_ratio=0.10),
    "neuralprophet": GateThreshold(min_weeks=12, max_gap_ratio=0.10),
    "lightgbm": GateThreshold(min_weeks=12, max_gap_ratio=0.10),
    "tft": GateThreshold(min_weeks=26, max_gap_ratio=0.05),
}


def evaluate_thresholds(
    *,
    model_type: str,
    weeks_of_history_available: float,
    total_expected_intervals: int,
    missing_intervals: int,
    tft_entitled: bool,
) -> tuple[bool, str | None]:
    """Pure ADR-0019 logic, no DB access. Returns `(passed, failure_reason)`.
    `failure_reason` is one of `DataQualityCheck.failure_reason`'s fixed enum
    values, or `None` when `passed` is `True`."""
    if model_type == "tft" and not tft_entitled:
        return False, "missing_tft_entitlement"

    threshold = THRESHOLDS[model_type]
    if weeks_of_history_available < threshold.min_weeks:
        return False, "insufficient_history"

    gap_ratio = missing_intervals / total_expected_intervals if total_expected_intervals > 0 else 1.0
    if gap_ratio > threshold.max_gap_ratio:
        return False, "excessive_gaps"

    return True, None


async def evaluate_gate(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    model_type: str,
    target_metric: str,
    interval_minutes: int,
    as_of: datetime | None = None,
) -> DataQualityCheck:
    as_of = as_of or datetime.now(UTC)
    threshold = THRESHOLDS[model_type]
    window_start = as_of - timedelta(weeks=threshold.min_weeks)

    tft_entitled = False
    if model_type == "tft":
        settings_row = await session.scalar(
            select(TenantSettings).where(TenantSettings.tenant_id == tenant_id)
        )
        tft_entitled = bool(settings_row and settings_row.tft_entitled)

    earliest = await session.scalar(
        select(func.min(HistoricalActual.interval_start)).where(
            HistoricalActual.tenant_id == tenant_id,
            HistoricalActual.org_unit_id == org_unit_id,
        )
    )
    weeks_available = 0.0
    if earliest is not None:
        weeks_available = max((as_of - earliest).total_seconds() / _WEEK_SECONDS, 0.0)

    actual_count = (
        await session.scalar(
            select(func.count()).where(
                HistoricalActual.tenant_id == tenant_id,
                HistoricalActual.org_unit_id == org_unit_id,
                HistoricalActual.interval_start >= window_start,
                HistoricalActual.interval_start < as_of,
            )
        )
        or 0
    )
    total_expected = max(int((as_of - window_start).total_seconds() // (interval_minutes * 60)), 0)
    missing = max(total_expected - actual_count, 0)

    passed, failure_reason = evaluate_thresholds(
        model_type=model_type,
        weeks_of_history_available=weeks_available,
        total_expected_intervals=total_expected,
        missing_intervals=missing,
        tft_entitled=tft_entitled,
    )

    now = datetime.now(UTC)
    check = DataQualityCheck(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        model_type=model_type,
        target_metric=target_metric,
        passed=passed,
        failure_reason=failure_reason,
        total_expected_intervals=total_expected,
        missing_intervals=missing,
        evaluated_at=now,
        created_at=now,
    )
    session.add(check)
    await session.flush()
    return check
