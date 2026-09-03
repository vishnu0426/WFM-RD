"""Module 06 Phase 5/ADR-0078's `LeaveService.GetUnavailability` pull -
closes the permanent gap ADR-0059 documented for `leave_records`
("no real leave/unavailability source exists anywhere in the platform...
until Module 06 ships"). Unlike `forecast_client`'s `found: bool` sentinel
(a forecast run either exists or doesn't), an empty `records` list here is
a perfectly normal, common response - "this employee has no approved leave
in this window" - so there is no not-found sentinel to check.
"""

from __future__ import annotations

import uuid
from datetime import date

import grpc

from app.grpc_clients.generated import leave_pb2, leave_pb2_grpc
from app.grpc_clients.retry import call_with_retry
from app.solver.types import LeaveRecord

_SERVICE = "LeaveService"


async def get_unavailability(
    channel: grpc.aio.Channel,
    *,
    tenant_id: uuid.UUID,
    employee_ids: tuple[uuid.UUID, ...],
    date_range_start: date,
    date_range_end: date,
) -> tuple[LeaveRecord, ...]:
    if not employee_ids:
        return ()

    stub = leave_pb2_grpc.LeaveServiceStub(channel)

    async def _fetch() -> leave_pb2.GetUnavailabilityResponse:
        request = leave_pb2.GetUnavailabilityRequest(
            tenant_id=str(tenant_id),
            employee_ids=[str(e) for e in employee_ids],
            date_range_start=date_range_start.isoformat(),
            date_range_end=date_range_end.isoformat(),
        )
        return await stub.GetUnavailability(request)

    response = await call_with_retry(_SERVICE, "GetUnavailability", _fetch)
    return tuple(
        LeaveRecord(
            employee_id=uuid.UUID(r.employee_id),
            start=date.fromisoformat(r.start_date),
            end=date.fromisoformat(r.end_date),
        )
        for r in response.records
    )
