"""Module 08/ADR-0102: `_resolve_policy`'s legal-floor pull -
`ComplianceRuleService.GetActiveRule` (adherence-compliance-service/,
`agno.compliance.v1`). Own copy of `policy_client.py`'s exact shape
(`_parse_definition`'s not-found/unparseable-both-fall-back-quietly
posture), pointed at a different service and RPC. Returns a plain parsed
`dict`, not a dataclass - the merge step in `solve_input_resolver.py` reads
whichever fields each `rule_type`'s own shape happens to carry, the same
way `policy_client.get_active_employment_policy` already does for
`EmploymentPolicy.definition`.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date

import grpc

from app.grpc_clients.generated import compliance_pb2, compliance_pb2_grpc
from app.grpc_clients.retry import call_with_retry

logger = logging.getLogger(__name__)

_SERVICE = "ComplianceRuleService"


async def get_active_rule_definition(
    channel: grpc.aio.Channel,
    *,
    tenant_id: uuid.UUID,
    jurisdiction: str,
    rule_type: str,
    as_of: date,
) -> dict[str, object] | None:
    """`None` when no `ComplianceRule` is currently in force for this
    (jurisdiction, rule_type) - distinct from an empty `dict`, which would
    mean "a rule exists but its definition has no fields," a real
    (if unusual) state a caller might otherwise conflate with "no floor to
    merge." `_resolve_policy`'s merge step must treat `None` as "nothing to
    merge for this field," never as "the floor requires zero.\""""
    stub = compliance_pb2_grpc.ComplianceRuleServiceStub(channel)
    request = compliance_pb2.GetActiveRuleRequest(
        tenant_id=str(tenant_id),
        jurisdiction=jurisdiction,
        rule_type=rule_type,
        as_of=as_of.isoformat(),
    )
    response = await call_with_retry(_SERVICE, "GetActiveRule", lambda: stub.GetActiveRule(request))
    if not response.found:
        return None
    try:
        parsed = json.loads(response.definition_json)
    except (json.JSONDecodeError, TypeError):
        logger.warning(
            "ComplianceRuleService.GetActiveRule returned unparseable definitionJson for rule %s "
            "(jurisdiction=%s, ruleType=%s) - treating as no floor for this field.",
            response.id,
            jurisdiction,
            rule_type,
        )
        return None
    return parsed if isinstance(parsed, dict) else None
