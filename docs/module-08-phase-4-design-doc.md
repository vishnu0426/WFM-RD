# Module 08 Phase 4 Design Doc — Adherence & Compliance: gRPC Contracts + Module 02/04 Reconciliation

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08), plus real changes to
Module 01/02 (root `src/`) and Module 04 (`scheduling-service/`, Python) -
this phase is explicitly not complete without both.
**Scope:** §7's own Phase 4 line, taken literally: "gRPC contracts +
Module 02/04 reconciliation. `GetActiveRule`/`ValidatePolicyAgainstFloor`
built and, critically, actually wired into Module 02's `EmploymentPolicy`
write path and Module 04's `PolicyService.GetActivePolicy` merge logic per
§0.6 - this phase isn't complete until those integration points are
demonstrated working, not just this module's own code." All three pieces
shipped: Module 08's own gRPC server (ADR-0100), Module 02's write-time
gate (ADR-0101), Module 04's solve-time merge (ADR-0102).

## Problem

Three real, load-bearing gaps between the module prompt's literal wording
and what could actually be built, each requiring its own decision before
writing any code:

1. **§3.3's two RPC signatures are both under-specified.** `GetActiveRule(jurisdiction,
   ruleType, asOfDate)` and `ValidatePolicyAgainstFloor(jurisdiction,
   policyDefinition)` omit `tenant_id` entirely, and the latter omits
   `rule_type` too - neither RPC is actually callable as literally
   specified once ADR-0095's tenant-override-vs-platform-default model is
   taken seriously (§2.2 rule 3). See ADR-0100.
2. **Neither `EmploymentPolicy` (Module 02) nor `EmploymentPolicy`
   (Module 04's own dataclass) carries a jurisdiction field.** Resolving
   "which country/state's law applies" for an org-unit-scoped policy or a
   solve job requires a real, disclosed decision about what data is
   actually reachable. Turned out to need no new core RPC at all on either
   side - `OrgUnit.countryCode` (Module 02, same-process) and
   `CalendarService.GetWorkingTimeRules`'s already-existing `country_code`
   field keyed by `org_unit_id` (Module 04, already-existing RPC) both
   sufficed. See ADR-0101/0102.
3. **A real, pre-existing bug blocked verification entirely**: `core.policies`'s
   `policy_type` CHECK constraint had drifted to only 6 of `PolicyType`'s
   11 values, because three separate migrations each replaced the whole
   constraint without reading the others' additions. A freshly-migrated
   database rejected every `EmploymentPolicy` write outright, before this
   phase's own gate could even be exercised. Fixed by
   `1700000011000-PoliciesTypeCheckConsolidationFix.ts`.

## Decision

**Module 08** (`adherence-compliance-service/`): first gRPC surface of any
kind. `compliance.proto` (`agno.compliance.v1`), `ComplianceRuleGrpcController`
(`GetActiveRule`/`ValidatePolicyAgainstFloor`, both reusing
`ComplianceRuleService`/`resolveEffectiveRules` rather than a parallel
implementation), `validate-policy-against-floor.ts` (the field-by-field,
per-`ruleType` stricter-direction comparator - see ADR-0100's own table).
`main.ts` gains a `connectMicroservice` hybrid transport, same shape as
every other gRPC-serving Node service in this platform.

**Module 02** (root `src/`): `EmploymentPoliciesService.create` now calls
a new `ComplianceGrpcClientService` (root's *first* outbound gRPC client -
every prior gRPC surface in this codebase was root itself being called)
before every write, resolving jurisdiction from `input.jurisdiction`
(new, optional field) or the target org unit's own `countryCode`. Rejects
the write (`EmploymentPolicyViolatesComplianceFloorError`) on a real
violation; fails closed (propagates, aborts the write) if the compliance
service is unreachable; skips validation entirely (logged) if no
jurisdiction is resolvable at all.

**Module 04** (`scheduling-service/`, Python): `_resolve_policy` now always
merges Module 08's compliance floor into whichever `EmploymentPolicy` it
resolved (explicit request body or Module 02 pull) via a new
`_merge_compliance_floor` step - two new clients (`calendar_client.py`,
`compliance_client.py`), stricter-wins-per-field (`_stricter_lower`/
`_stricter_higher`), fails closed via the existing `_call_upstream`
wrapper every other pull in this function already uses.

## Blast radius
- **Module 08**: new `src/grpc/` (proto, controller, module),
  `validate-policy-against-floor.ts`, `getActiveRule` method on the
  existing service, `main.ts`/`app.module.ts`/`package.json`/`nest-cli.json`
  additive changes. One new ADR (0100).
- **Root**: new `src/grpc/compliance-grpc-client.*` (constants/service/module),
  new error class, `CreateEmploymentPolicyInput.jurisdiction` field,
  `EmploymentPoliciesService`/`PolicyModule` additive changes, one new
  migration (`1700000011000`, the `policies_type_check` fix), one new ADR
  (0101).
- **scheduling-service**: two new gRPC clients + their regenerated stubs
  (`calendar_pb2*`, `compliance_pb2*`), two new config/channel entries,
  `solve_input_resolver.py`'s merge logic, `pyproject.toml`'s mypy override
  gains two module names. One new ADR (0102).
- Zero changes to any other module's own request path, schema, or running
  code - the blast radius is exactly the three integration points §0.6
  names, nothing wider.

## Verification

Real, running processes, not mocks, for every claim below - core (root
`src/`, gRPC on a non-default port since macOS's AirPlay Receiver occupies
`:5000` on this local machine, a host quirk not a platform default change)
and adherence-compliance-service (gRPC `:7100`) both booted from their own
`dist/` builds against the real local Postgres:

- **Module 02 → Module 08 (the write-time gate), via real GraphQL calls
  through a real running root process**: seeded a real, activated `US`
  `rest_period_minimum` `ComplianceRule` (10h floor) through Module 08's
  own GraphQL API; a `createEmploymentPolicy` call proposing 5h rest was
  rejected with the exact expected `EMPLOYMENT_POLICY_VIOLATES_COMPLIANCE_FLOOR`
  error and violation text; a call proposing 12h succeeded; a call for a
  jurisdiction (`JP`) with no seeded floor succeeded (fail-open on
  `floorNotFound`); killing Module 08's gRPC server and retrying the 9h
  case produced a clean unavailability error, confirming the write was
  genuinely rejected, not silently allowed through.
- **Module 04 → Module 02/08 (the solve-time merge), against real running
  servers**: with the real seeded `US` floor still live, a direct call to
  `calendar_client.get_org_unit_country_code` against the real core
  process correctly resolved `"US"` for a real org unit (after seeding a
  real `WorkingTimeCalendar` row for it - the same "no calendar configured
  for this specific org unit" gap Phase 3 hit once already, recurring here
  independently); `compliance_client.get_active_rule_definition` against
  the real adherence-compliance-service process correctly returned the
  seeded floor's definition; and the full `_merge_compliance_floor`
  function, run against both real servers together (channel singletons
  patched to point at the real local ports, not mocked), correctly
  overrode a looser 5h base policy with the real floor's 10h value while
  leaving an untouched field (`max_consecutive_working_days`) unchanged.

All three integration points are demonstrated working end to end, per
§7's own completion bar for this phase - not asserted from unit tests
alone.

## Explicit assumptions (spec was ambiguous or silent here)
1. **Both RPC signatures gain `tenant_id`; `ValidatePolicyAgainstFloor`
   also gains `rule_type`** - beyond §3.3's literal wording, required for
   either RPC to be answerable at all given ADR-0095's design (ADR-0100).
2. **Jurisdiction resolution is country-level only on both integration
   points** (`OrgUnit.countryCode`), never state/subdivision - neither
   `OrgUnit` nor `EmploymentPolicy` (Module 02 or 04) carries a finer-grained
   field. A tenant wanting a state-specific (e.g. "US-CA") comparison must
   supply `jurisdiction` explicitly on the Module 02 side; no equivalent
   override exists on the Module 04 solve-input side in this phase.
3. **`overtime_threshold` floors are enforced only by Module 02's write-time
   gate, never merged into Module 04's `EmploymentPolicy`** - that
   dataclass has no corresponding field (§3.1's own table sources
   contracted hours from `Employee`, not a policy).
4. **The compliance-floor merge runs unconditionally in `_resolve_policy`**,
   including when the request body supplies an explicit `policy` - ADR-0059
   Decision 2's "explicit wins outright" governs policy *source* selection,
   not whether the legal floor still applies once a source is chosen.
5. **`policies_type_check`'s fix is unconditionally correct** regardless of
   this phase's own floor-validation feature - flagged as a real,
   independent bug this phase's own verification needed working
   `EmploymentPolicy` writes to even discover.

## Out of scope for this phase (do not build yet)
- `RuleChangeImpactPreview` - Phase 5.
- Any RBAC/permission check on either gRPC client's calls, or on either
  server's RPCs - matches this platform's existing posture for every other
  internal service-to-service gRPC contract.
- Closing the state/subdivision jurisdiction-precision gap - would require
  new schema work on `OrgUnit` itself, a different module's scope.
- `generateComplianceReport`, the retention lifecycle job - Phases 6/7,
  unrelated to and unaffected by this phase's work.
