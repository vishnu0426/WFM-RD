"""Module 08/ADR-0102: `_resolve_policy`'s jurisdiction-resolution step. This
service already has `org_unit_id` in hand for every solve (`body.org_unit_id`)
but has no jurisdiction/country concept anywhere in its own data model.
`CalendarService.GetWorkingTimeRules` (core, `src/grpc/proto/calendar.proto`)
already exists, already returns `country_code` keyed directly by
`org_unit_id`, and already has a real consumer in a different service
(attendance-leave-service's own `CalendarGrpcClientService`) - reusing it
here needed no core-side change at all, unlike Module 08's own
`EmployeeService.GetEmployeeOrgUnits` (ADR-0099), which *did* need a new
RPC because no employee-id-keyed lookup existed anywhere.

Country-level precision only ("US", never "US-CA") - `OrgUnit` carries no
subdivision field, the same disclosed limitation ADR-0101 accepted for
Module 02's own write-time gate.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date

import grpc

from app.grpc_clients.generated import calendar_pb2, calendar_pb2_grpc
from app.grpc_clients.retry import call_with_retry

logger = logging.getLogger(__name__)

_SERVICE = "CalendarService"


async def get_org_unit_country_code(
    channel: grpc.aio.Channel, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, as_of: date
) -> str | None:
    """`None` when core has no calendar configured for this org unit at all
    (a tenant-wide default calendar's own `country_code` may still be
    empty) - the caller must treat that as "jurisdiction unknown," not
    coerce it to any particular country."""
    stub = calendar_pb2_grpc.CalendarServiceStub(channel)
    request = calendar_pb2.GetWorkingTimeRulesRequest(
        tenant_id=str(tenant_id),
        org_unit_id=str(org_unit_id),
        from_date=as_of.isoformat(),
        to_date=as_of.isoformat(),
    )
    response = await call_with_retry(
        _SERVICE, "GetWorkingTimeRules", lambda: stub.GetWorkingTimeRules(request)
    )
    return response.country_code or None
