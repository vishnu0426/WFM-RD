# ADR-0100: `ComplianceRuleService` gRPC signatures deviate from the literal spec, and the floor-comparison algorithm is a disclosed, per-field interpretation

## Context
§3.3 specifies two RPCs in three and two arguments respectively:
`GetActiveRule(jurisdiction, ruleType, asOfDate)` and
`ValidatePolicyAgainstFloor(jurisdiction, policyDefinition)`. Implementing
both for real surfaced that neither literal signature is actually
sufficient:

1. **`GetActiveRule` needs `tenant_id`.** ADR-0095's whole
   tenant-override-vs-platform-default design (§2.2 rule 3) depends on
   knowing which tenant is asking - without it, this RPC could only ever
   resolve the platform-default row, never a tenant's own stricter
   override, defeating the point of the override existing at all.
2. **`ValidatePolicyAgainstFloor` needs both `tenant_id` (same reason) and
   `rule_type`.** A `policyDefinition`'s shape is `rule_type`-dependent
   (§2.1 rule 4 - arbitrary jsonb) - there is no way to know *which* floor
   to compare an opaque JSON blob against without being told the rule type
   it claims to satisfy.
3. **Neither Module 02's `EmploymentPolicy` nor this module's own
   `ComplianceRule` carries a `jurisdiction`/"which country's law applies"
   field anywhere obviously reachable.** `EmploymentPolicy` is
   `org_unit_id`-scoped, not jurisdiction-scoped; resolving jurisdiction
   from an org unit means going through `OrgUnit.countryCode` (Module 02's
   own schema) - country-level precision only, never state/subdivision
   (`OrgUnit` has no such field). This is a real, disclosed limitation
   pushed onto both integration points (§0.6's actual write path and
   Module 04's merge logic), not something this module's own gRPC
   contract can fix on its own.

A fourth, more substantive question: **what does "at least as strict as
the floor" actually mean, field by field?** `definition` is arbitrary
jsonb; nothing in this platform's schema encodes which direction (higher
or lower) is more protective for a given field. This has to be a stated,
disclosed interpretation, the same honesty posture ADR-0067/0098 already
established for other underspecified fields in this platform.

## Decision

**Both RPCs gain the fields they actually need**, beyond the module
prompt's literal signatures - `GetActiveRuleRequest` adds `tenant_id`;
`ValidatePolicyAgainstFloorRequest` adds `tenant_id` and `rule_type`
(`compliance.proto`). Both are implemented by reusing
`ComplianceRuleService`/`resolveEffectiveRules` (the exact "one canonical
representation" reuse the Phase 2/3 design docs already committed to,
not a parallel implementation).

**`ValidatePolicyAgainstFloor` fails open, not closed, when no floor
exists** (`floorNotFound: true`, `valid: true`) - §0.6 frames the floor as
"what the law requires," and a floor this module hasn't encoded yet cannot
reject a write for failing to meet a requirement nobody has stated. This is
distinct from a genuine violation (`valid: false`), and callers must not
conflate the two.

**The floor-comparison algorithm** (`validate-policy-against-floor.ts`) is
a field-by-field, per-`ruleType` direction map - a real, disclosed
interpretation of what "stricter" means for each field this platform's
only two current producers of these shapes (this module's own seed-worthy
examples, and scheduling-service's `policy_client.py`, the sole existing
consumer-defined shape for `rest_period_minimum`/`max_consecutive_days`/
`union_rule`) already use:

| `ruleType` | field | stricter direction |
|---|---|---|
| `overtime_threshold` | `dailyThresholdHours`, `weeklyThresholdHours` | lower (overtime kicks in sooner) |
| `overtime_threshold` | `multiplier` | higher (more overtime pay) |
| `rest_period_minimum` | `minRestHoursBetweenShifts` | higher (more required rest) |
| `max_consecutive_days` | `maxConsecutiveWorkingDays` | lower (fewer consecutive days allowed) |
| `union_rule` | `minShiftLengthMinutes` | higher (longer guaranteed shift) |
| `union_rule` | `maxShiftLengthMinutes` | lower (tighter cap) |
| `union_rule` | `mandatoryBreakAfterHours` | lower (break required sooner) |
| `union_rule` | `mandatoryBreakMinutes` | higher (longer mandatory break) |

A field the floor doesn't itself constrain is never checked (the floor
only requires what it actually specifies); a field the floor *does*
constrain but the policy omits is a violation (fails safe). No entry
exists for `break_requirement` - Module 02's `EmploymentPolicyType` enum
has no corresponding value, so this comparator is never called for it in
practice; the empty map is deliberate, not an oversight.

**Jurisdiction resolution is country-level-only, resolved by each caller
from data it already has**, not from a new field this module's own schema
grows: Module 02's `EmploymentPoliciesService.create` already fetches the
target `OrgUnit` (for existence-checking) and can read `.countryCode` off
that same object; scheduling-service's `solve_input_resolver.py` already
has `org_unit_id` in hand and gains one new client
(`calendar_client.py`) calling core's *already-existing*
`CalendarService.GetWorkingTimeRules`, whose response already carries
`country_code` keyed by that exact `org_unit_id` - no proto change to
`employee.proto`/`calendar.proto` was needed for either caller. Both
integration points are therefore limited to whatever jurisdiction
precision a bare ISO country code provides - a real, disclosed limitation
(a California-specific rule cannot be distinguished from a generic
US-federal one by either caller), not a defect introduced by this ADR.

## Consequences
- `compliance.proto`'s two request messages are not literally what §3.3
  describes - any future consumer must read the actual `.proto` file, not
  the module prompt's prose, for the real contract.
- The floor-comparison table above is this platform's one and only
  definition of "stricter" for these four rule types. A future rule type,
  or a future field on an existing one, needs its own considered direction
  entry here - there is no way to derive it from the schema.
- Module 02's write-time gate and Module 04's merge logic can only ever be
  as jurisdiction-precise as an org unit's `countryCode` - closing this to
  state/subdivision precision would require adding a real
  jurisdiction/subdivision field to `OrgUnit` itself, new schema work in a
  different module, out of scope for this ADR.
- `ValidatePolicyAgainstFloor`'s fail-open-on-no-floor posture means a
  tenant can still create an `EmploymentPolicy` for a jurisdiction this
  module has no seeded `ComplianceRule` for at all - expected, not a gap
  this ADR is responsible for closing (seeding real jurisdictional data is
  a legal/compliance-officer content task, per this module's own §8
  non-goals, not an engineering one).
