"""Phase 6/ADR-0059's `ForecastService` pull - fills in a `ShiftSlot`'s
`requiredHeadcount` when a job submission omits it, from the forecast run's
own interval-level `required_headcount` (Module 03's Erlang C output,
`ForecastDataPoint`). A shift must be staffed for its peak interval, not its
average one - `derive_required_headcount` takes the **max** across every
interval the shift's own `[start, end)` window overlaps.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

import grpc

from app.grpc_clients.generated import forecast_pb2, forecast_pb2_grpc
from app.grpc_clients.retry import call_with_retry

_SERVICE = "ForecastService"


@dataclass(frozen=True)
class ForecastRequirement:
    interval_start: datetime
    interval_minutes: int
    required_headcount: Decimal | None


async def get_forecast_requirements(
    channel: grpc.aio.Channel, *, tenant_id: uuid.UUID, forecast_run_id: uuid.UUID
) -> tuple[ForecastRequirement, ...] | None:
    """`None` when `forecast_run_id` isn't found (doesn't exist, wrong
    tenant, or not yet `completed`) - distinct from an empty tuple, which
    means a found run with genuinely zero interval data."""
    stub = forecast_pb2_grpc.ForecastServiceStub(channel)

    async def _fetch() -> forecast_pb2.GetForecastRequirementsResponse:
        request = forecast_pb2.GetForecastRequirementsRequest(
            tenant_id=str(tenant_id), forecast_run_id=str(forecast_run_id)
        )
        return await stub.GetForecastRequirements(request)

    response = await call_with_retry(_SERVICE, "GetForecastRequirements", _fetch)
    if not response.found:
        return None
    return tuple(
        ForecastRequirement(
            interval_start=datetime.fromisoformat(r.interval_start),
            interval_minutes=r.interval_minutes,
            required_headcount=Decimal(r.required_headcount) if r.required_headcount else None,
        )
        for r in response.requirements
    )


def derive_required_headcount(
    requirements: tuple[ForecastRequirement, ...], *, shift_start: datetime, shift_end: datetime
) -> int | None:
    """`None` when no overlapping interval has a computed
    `required_headcount` at all (nothing to derive from - the caller decides
    what that means for the shift, this function never guesses a number)."""
    overlapping = [
        r.required_headcount
        for r in requirements
        if r.required_headcount is not None
        and shift_start < r.interval_start + timedelta(minutes=r.interval_minutes)
        and r.interval_start < shift_end
    ]
    if not overlapping:
        return None
    return int(max(overlapping).to_integral_value(rounding="ROUND_CEILING"))
