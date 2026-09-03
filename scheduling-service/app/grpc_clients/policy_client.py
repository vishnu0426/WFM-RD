"""Phase 6/ADR-0059's `PolicyService` pull - replaces ADR-0055's
request-supplied `policy` when a job submission omits it.

`EmploymentPolicy.definition` (Module 01/02) has no pinned-down JSON shape
anywhere else in the platform - `policy.proto` documents it as "arbitrary
shape per §2.1 rule 4" and nothing in Module 01/02's own code validates it
beyond `Record<string, unknown>`. ADR-0059 Decision 3 is this module's own
contract for what it expects in each of the three `policy_type` values it
actually needs (`OVERTIME_THRESHOLD` maps to nothing here - contracted
hours comes from `Employee`, not a policy, per §3.1's own table). A
`found: false` response or a `definition_json` that doesn't parse as the
expected shape both fall back to that field's platform default
independently (ADR-0059 Decision 4) - never a whole-policy failure over one
tenant's unconfigured/malformed field.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date

import grpc

from app.grpc_clients.generated import policy_pb2, policy_pb2_grpc
from app.grpc_clients.retry import call_with_retry
from app.solver.types import EmploymentPolicy

logger = logging.getLogger(__name__)

_SERVICE = "PolicyService"

# ADR-0059 Decision 4's platform defaults - applied per field, independently,
# whenever that field's own policy_type lookup comes back not-found or
# unparseable. "No minimum/maximum shift length, no mandatory break" is
# deliberately a no-op, not a blocking constraint, for a tenant that hasn't
# configured a union rule at all.
_DEFAULT_MIN_REST_HOURS_BETWEEN_SHIFTS = 8.0
_DEFAULT_MAX_CONSECUTIVE_WORKING_DAYS = 6
_DEFAULT_MIN_SHIFT_LENGTH_MINUTES = 0


async def get_active_employment_policy(
    channel: grpc.aio.Channel, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, as_of: date
) -> EmploymentPolicy:
    stub = policy_pb2_grpc.PolicyServiceStub(channel)

    async def _fetch(policy_type: str) -> policy_pb2.PolicyResponse:
        request = policy_pb2.GetActivePolicyRequest(
            tenant_id=str(tenant_id),
            policy_type=policy_type,
            org_unit_id=str(org_unit_id),
            as_of=as_of.isoformat(),
        )
        return await call_with_retry(_SERVICE, "GetActivePolicy", lambda: stub.GetActivePolicy(request))

    rest_response = await _fetch("rest_period_minimum")
    max_days_response = await _fetch("max_consecutive_days")
    union_rule_response = await _fetch("union_rule")

    min_rest_hours_between_shifts = _parse_field(
        rest_response, "minRestHoursBetweenShifts", _DEFAULT_MIN_REST_HOURS_BETWEEN_SHIFTS
    )
    max_consecutive_working_days = int(
        _parse_field(max_days_response, "maxConsecutiveWorkingDays", _DEFAULT_MAX_CONSECUTIVE_WORKING_DAYS)
    )

    union_rule_definition = _parse_definition(union_rule_response)
    min_shift_length_minutes = int(
        _field_or_default(
            union_rule_definition, "minShiftLengthMinutes", _DEFAULT_MIN_SHIFT_LENGTH_MINUTES
        )
    )
    max_shift_length_minutes = _optional_int_field(union_rule_definition, "maxShiftLengthMinutes")
    mandatory_break_after_hours = _optional_float_field(union_rule_definition, "mandatoryBreakAfterHours")
    mandatory_break_minutes = _optional_int_field(union_rule_definition, "mandatoryBreakMinutes")

    return EmploymentPolicy(
        max_consecutive_working_days=max_consecutive_working_days,
        min_rest_hours_between_shifts=min_rest_hours_between_shifts,
        min_shift_length_minutes=min_shift_length_minutes,
        max_shift_length_minutes=max_shift_length_minutes,
        mandatory_break_after_hours=mandatory_break_after_hours,
        mandatory_break_minutes=mandatory_break_minutes,
    )


def _parse_definition(response: policy_pb2.PolicyResponse) -> dict[str, object]:
    if not response.found:
        return {}
    try:
        parsed = json.loads(response.definition_json)
    except (json.JSONDecodeError, TypeError):
        logger.warning(
            "PolicyService.GetActivePolicy returned unparseable definitionJson for policy %s "
            "(policyType=%s) - falling back to platform defaults for its fields.",
            response.id,
            response.policy_type,
        )
        return {}
    if not isinstance(parsed, dict):
        return {}
    return parsed


def _field_or_default(definition: dict[str, object], field: str, default: float) -> float:
    value = definition.get(field)
    return float(value) if isinstance(value, int | float) else default


def _parse_field(response: policy_pb2.PolicyResponse, field: str, default: float) -> float:
    return _field_or_default(_parse_definition(response), field, default)


def _optional_int_field(definition: dict[str, object], field: str) -> int | None:
    value = definition.get(field)
    return int(value) if isinstance(value, int | float) else None


def _optional_float_field(definition: dict[str, object], field: str) -> float | None:
    value = definition.get(field)
    return float(value) if isinstance(value, int | float) else None
