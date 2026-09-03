# ADR-0102: scheduling-service merges Module 08's compliance floor into `EmploymentPolicy`, stricter wins per field, fails closed

## Context
§0.6's other required integration point (ADR-0101 closed the first,
Module 02's write-time gate): "`PolicyService.GetActivePolicy` (used by
Module 04's solver) must resolve both the applicable `ComplianceRule` (via
this module's gRPC) as the non-negotiable floor, and the tenant's
`EmploymentPolicy` as any additional/stricter constraint on top - merge
them, with the stricter value winning per field, and encode the merged
result in CP-SAT."

`_resolve_policy` (`app/services/solve_input_resolver.py`) already pulls
`EmploymentPolicy` from core's `PolicyService.GetActivePolicy` (ADR-0059).
Implementing the merge surfaced the same jurisdiction-resolution problem
ADR-0101 hit on the Module 02 side, solved the same way: this service
already has `org_unit_id` in hand for every solve, and
`CalendarService.GetWorkingTimeRules` (core, already existing, already
consumed by a different service) already returns `country_code` keyed
directly by `org_unit_id` - no proto change anywhere was needed to resolve
jurisdiction, only a new client (`calendar_client.py`) this service never
had before.

`EmploymentPolicy` (`app/solver/types.py`) has no field corresponding to
`overtime_threshold` at all - §3.1's own table maps contracted hours from
`Employee`, not a policy, for that dimension. The merge below therefore
only ever touches three rule types: `rest_period_minimum`,
`max_consecutive_days`, `union_rule` - `overtime_threshold` floors exist
in Module 08's data and are enforced by Module 02's write-time gate
(ADR-0101), but have nothing to merge into on this side.

## Decision

Two new gRPC clients, own copies of `policy_client.py`'s exact shape:
- `calendar_client.get_org_unit_country_code(channel, *, tenant_id, org_unit_id, as_of) -> str | None`
  - calls core's `CalendarService.GetWorkingTimeRules`.
- `compliance_client.get_active_rule_definition(channel, *, tenant_id, jurisdiction, rule_type, as_of) -> dict[str, object] | None`
  - calls adherence-compliance-service's new `ComplianceRuleService.GetActiveRule`
    (ADR-0100). Regenerated stubs (`compliance_pb2.py`/`_grpc.py`,
    `calendar_pb2.py`/`_grpc.py`) via the same `grpc_tools.protoc` command
    this service already uses for every other cross-repo proto, pointed at
    `../adherence-compliance-service/src/grpc/proto/compliance.proto` and
    `../src/grpc/proto/calendar.proto` respectively - no local proto copy,
    matching this service's own established convention.

`_resolve_policy` now always calls a new `_merge_compliance_floor` step
after determining the base `EmploymentPolicy` - **whether that policy came
from an explicit request body or a Module 02 pull.** ADR-0059 Decision 2's
"explicit wins outright, no merge" governs which policy *source* the
solver uses; it says nothing about whether the legal floor still applies
once a source is chosen, and §0.6 gives no indication a supervisor's
explicit override should be able to bypass a legal minimum by construction.

**Stricter-wins-per-field**, computed by two small helpers
(`_stricter_lower`/`_stricter_higher`) matching Module 08's own
ADR-0100 direction table exactly (`min_rest_hours_between_shifts`: higher
wins; `max_consecutive_working_days`: lower wins; `min_shift_length_minutes`:
higher wins; `max_shift_length_minutes`/`mandatory_break_after_hours`:
lower wins; `mandatory_break_minutes`: higher wins). A field the floor
doesn't specify leaves the policy's own value untouched; a field the
*policy* leaves unset (`None`, for the three `Optional` fields) but the
floor *does* specify is filled in by the floor outright - `None` is never
treated as "no constraint beats any constraint."

**Fails closed**, via the same `_call_upstream` wrapper every other gRPC
pull in this function already uses - a solve job that cannot confirm its
policy meets the legal floor must not silently proceed with an unverified
one, same posture ADR-0101 chose for Module 02's write path. The one
exception: if `calendar_client` resolves no country code at all (no
calendar configured for this org unit), the merge is skipped with a
logged warning, not failed - there is no jurisdiction to look up a floor
for, the identical disclosed limitation ADR-0101 already accepted.

## Consequences
- A solve job now depends on two additional services being reachable
  (core's `CalendarService`, adherence-compliance-service's
  `ComplianceRuleService`) beyond what it already depended on. A new
  `compliance_grpc_url` setting (default `localhost:7100`, matching
  adherence-compliance-service's own default) and `get_compliance_channel()`
  singleton were added to this service's existing config/channel-singleton
  machinery, no new pattern introduced.
- `EmploymentPolicy`'s fields going into CP-SAT may now be *stricter* than
  whatever Module 02 (or an explicit request body) specified - by design,
  and worth stating plainly for anyone debugging "why did the solver apply
  a constraint I didn't configure": it came from the jurisdiction's legal
  floor, not from `EmploymentPolicy` itself.
- Jurisdiction precision is country-level only here too (same
  `OrgUnit.countryCode`-sourced limitation ADR-0101 accepted) -
  `overtime_threshold` floors are never merged into `EmploymentPolicy` at
  all, since no corresponding field exists to merge them into; they remain
  enforced exclusively by Module 02's write-time gate.
- `pyproject.toml`'s existing mypy override for grpc-client modules
  (untyped generated stub calls) gained `calendar_client`/`compliance_client` -
  additive, the same four pre-existing entries unchanged.
