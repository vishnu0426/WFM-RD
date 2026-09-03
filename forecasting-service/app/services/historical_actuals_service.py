"""Landing-zone writer for `forecasting.historical_actuals` (ADR-0020, Gap 1).
Not an ingestion pipeline - just the batch-upsert `POST /v1/forecasting/actuals`
calls into."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import HistoricalActual


@dataclass(frozen=True)
class ActualPoint:
    interval_start: datetime
    actual_volume: Decimal | None
    actual_aht_seconds: Decimal | None
    actual_shrinkage_pct: Decimal | None


# Postgres hard-caps bind parameters at 32767 per statement. Each row here
# binds 8 (id/tenant_id/org_unit_id/interval_start/3 metrics/created_at), so
# a single multi-VALUES INSERT stops being safe past ~4095 rows - a real
# limit a tenant backfilling months of onboarding history (a realistic
# ingestion size, not a pathological one) would actually hit. Found by
# running this against a real Postgres with a multi-week seed, not
# hypothesized - `InterfaceError: the number of query arguments cannot
# exceed 32767`. Chunked well under that ceiling.
_MAX_ROWS_PER_STATEMENT = 2000


async def ingest_actuals(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    points: list[ActualPoint],
) -> int:
    """Upserts on `(tenant_id, org_unit_id, interval_start)` - a resubmission
    of the same interval (e.g. a corrected export) overwrites rather than
    duplicates. Returns the number of rows written."""
    if not points:
        return 0

    now = datetime.now(UTC)
    values = [
        {
            "id": uuid.uuid4(),
            "tenant_id": tenant_id,
            "org_unit_id": org_unit_id,
            "interval_start": point.interval_start,
            "actual_volume": point.actual_volume,
            "actual_aht_seconds": point.actual_aht_seconds,
            "actual_shrinkage_pct": point.actual_shrinkage_pct,
            "created_at": now,
        }
        for point in points
    ]

    for chunk_start in range(0, len(values), _MAX_ROWS_PER_STATEMENT):
        chunk = values[chunk_start : chunk_start + _MAX_ROWS_PER_STATEMENT]
        stmt = pg_insert(HistoricalActual).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["tenant_id", "org_unit_id", "interval_start"],
            set_={
                "actual_volume": stmt.excluded.actual_volume,
                "actual_aht_seconds": stmt.excluded.actual_aht_seconds,
                "actual_shrinkage_pct": stmt.excluded.actual_shrinkage_pct,
            },
        )
        await session.execute(stmt)

    return len(values)
