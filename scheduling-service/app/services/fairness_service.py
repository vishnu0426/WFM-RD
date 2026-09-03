"""§3.3's `FairnessLedger` query surface: the rolling-period lookup
`job_service`/the API layer needs before a solve to seed
`SolveInput.fairness_history_counts`, plus the platform-default/stored-
config parsing `schedule_service.publish_schedule` needs to classify a
schedule's own shifts as undesirable-or-not at publish time.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FairnessLedger
from app.solver.types import FairnessConfig

# Platform defaults - used whenever a job's own `constraint_config` didn't
# set a `fairness` block (§2.2 rule 3: tenant-configurable, never hardcoded
# *per deploy*, but a documented default is not the same thing as a
# per-deploy hardcode - Module 03's `ServiceLevelTarget` takes the same
# "platform default applies when no row/value exists" posture).
_DEFAULT_ROLLING_PERIOD_WEEKS = 4
_DEFAULT_TOLERANCE = 1
_DEFAULT_NIGHT_START_HOUR = 22
_DEFAULT_NIGHT_END_HOUR = 6


def default_fairness_config() -> FairnessConfig:
    return FairnessConfig(
        rolling_period_weeks=_DEFAULT_ROLLING_PERIOD_WEEKS,
        tolerance=_DEFAULT_TOLERANCE,
        include_weekends=True,
        night_start_hour=_DEFAULT_NIGHT_START_HOUR,
        night_end_hour=_DEFAULT_NIGHT_END_HOUR,
    )


def parse_fairness_config(constraint_config: dict[str, Any]) -> FairnessConfig:
    """Reconstructs the `FairnessConfig` used to classify a job's shifts as
    undesirable-or-not, from that job's own stored `constraint_config`
    (§2.2 rule 3's jsonb, validated at submission time by
    `ConstraintConfigInput`) if it set one, otherwise the platform default.
    Frozen at publish time (`schedule_service.publish_schedule`) - what
    makes each `FairnessLedger` row's `is_undesirable` durable and
    re-auditable regardless of what the platform's definition becomes
    later."""
    fairness = constraint_config.get("fairness")
    if not fairness:
        return default_fairness_config()
    holiday_dates = frozenset(date.fromisoformat(d) for d in fairness.get("holidayDates", []))
    return FairnessConfig(
        rolling_period_weeks=fairness.get("rollingPeriodWeeks", _DEFAULT_ROLLING_PERIOD_WEEKS),
        tolerance=fairness.get("tolerance", _DEFAULT_TOLERANCE),
        include_weekends=fairness.get("includeWeekends", True),
        night_start_hour=fairness.get("nightStartHour", _DEFAULT_NIGHT_START_HOUR),
        night_end_hour=fairness.get("nightEndHour", _DEFAULT_NIGHT_END_HOUR),
        holiday_dates=holiday_dates,
    )


async def get_historical_undesirable_counts(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    employee_ids: Sequence[uuid.UUID],
    window_start: date,
    window_end: date,
) -> dict[uuid.UUID, int]:
    """§3.3's rolling-period lookup, scoped to exactly the roster being
    solved for. `window_end` is exclusive - the caller's own solve scope
    starts there, and nothing in it has been published yet, so nothing
    there could already be in the ledger (avoids double-counting the same
    shifts once *this* job is eventually published)."""
    if not employee_ids:
        return {}
    window_start_dt = datetime(window_start.year, window_start.month, window_start.day, tzinfo=UTC)
    window_end_dt = datetime(window_end.year, window_end.month, window_end.day, tzinfo=UTC)
    result = await session.execute(
        select(FairnessLedger.employee_id, func.count())
        .where(
            FairnessLedger.tenant_id == tenant_id,
            FairnessLedger.employee_id.in_(employee_ids),
            FairnessLedger.is_undesirable.is_(True),
            FairnessLedger.shift_start >= window_start_dt,
            FairnessLedger.shift_start < window_end_dt,
        )
        .group_by(FairnessLedger.employee_id)
    )
    counts: dict[uuid.UUID, int] = {row[0]: row[1] for row in result.all()}
    return {employee_id: counts.get(employee_id, 0) for employee_id in employee_ids}
