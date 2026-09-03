# ADR-0101: `EmploymentPoliciesService.create` calls Module 08's `ValidatePolicyAgainstFloor` before every write, fails closed on unavailability

## Context
§0.6 (Module 08's spec) requires that "any create/update to `EmploymentPolicy`
(Module 02's API) must call this module's gRPC
`ComplianceRuleService.ValidatePolicyAgainstFloor(jurisdiction,
policyDefinition)` before the write commits - reject the write if the
proposed policy would be less protective than the applicable
`ComplianceRule`." `EmploymentPoliciesService.create`
(`src/modules/policy/services/employment-policies.service.ts`) is the one
write path this applies to (`EmploymentPolicyType`'s four org-unit-scoped
values; the generic `PolicyManagementService.createOrVersion` write path
serves Module 01's own tenant-wide policy types, none of which Module 08
has a corresponding floor for).

Two real problems surfaced implementing this:

1. **Neither `EmploymentPolicy` nor `OrgUnit` carries a jurisdiction field
   precise enough for state/subdivision-level rules.** `OrgUnit.countryCode`
   is the only geography Module 02's own schema has. Resolving "US-CA" from
   an org unit is not possible with today's data model - only "US" is.
2. **A real, pre-existing bug in `core.policies`'s own `policy_type` CHECK
   constraint** (found while wiring this): `1700000006000-Module01Phase3SsoSchema.ts`
   replaced the entire constraint with a 6-value list, silently dropping
   the four `EmploymentPolicy` types and `skill_decay_half_life` two
   earlier migrations had already added. A freshly-migrated database
   rejected every `EmploymentPolicy` write with a `CHECK` violation before
   this ADR's own change could even be exercised. Fixed by
   `1700000011000-PoliciesTypeCheckConsolidationFix.ts`, consolidating to
   the full 11-value list matching the `PolicyType` TS enum exactly - a
   genuine correctness fix this ADR's own work needed, not new scope this
   ADR introduces.

## Decision

**`CreateEmploymentPolicyInput` gains an optional `jurisdiction` field**
(ISO country or country-subdivision code). When omitted and `orgUnitId` is
set, `EmploymentPoliciesService.create` falls back to that org unit's own
`countryCode` (already fetched for existence-checking - no new query).
When both are absent (a tenant-wide policy with no explicit jurisdiction),
the floor-validation gate is skipped entirely, logged, not failed - there
is no jurisdiction to resolve a floor against, and §0.6's floor cannot
reject what it has no way to identify.

**`ComplianceGrpcClientModule`/`Service`** (`src/grpc/compliance-grpc-client.*`) -
root's first outbound gRPC client of any kind (every prior gRPC surface in
this file was a server root itself exposes; this is the first time root
calls *out*). Own copy of every downstream service's identical
`ClientsModule.registerAsync` shape, pointed at
`adherence-compliance-service/src/grpc/proto/compliance.proto` - a direct
subdirectory of this repo's own root, so its `protoPath` needs no `../`
prefix, unlike every other service's copy of this pattern (which live one
level below root and do need it).

**Fails closed on gRPC unavailability** - `EmploymentPoliciesService.create`
does not catch `ComplianceGrpcClientUnavailableError`; it propagates,
aborting the write. Same posture attendance-leave-service's own
`LeaveConflictCheckService` (ADR-0074, §2.2 rule 2) already established
for a different safety-critical synchronous check: a write this module
cannot confirm meets a legal floor must not silently succeed because the
validator happened to be unreachable at that moment. This is a real
availability coupling - `EmploymentPolicy` writes now depend on Module 08
being up - accepted deliberately, not overlooked, because the alternative
(fail open) would mean this gate provides no actual guarantee whenever it
matters most.

**`floorNotFound: true` never blocks a write**, matching ADR-0100's own
fail-open-on-no-floor design - a jurisdiction/rule_type Module 08 hasn't
seeded a `ComplianceRule` for yet cannot reject a policy for failing to
meet a requirement that isn't encoded.

## Consequences
- `EmploymentPolicy` writes are now precision-limited to whatever a bare
  ISO country code provides - a California-specific rule and a
  generic-US-federal one are indistinguishable to this gate unless the
  caller supplies `jurisdiction` explicitly. Closing this requires a real
  jurisdiction/subdivision field on `OrgUnit` itself - new schema work in a
  different module, out of scope here.
- `PolicyModule` now depends on `ComplianceGrpcClientModule`
  (`COMPLIANCE_GRPC_URL` env var, default `localhost:7100` matching
  adherence-compliance-service's own default `GRPC_URL`) - a new runtime
  dependency for every environment running root, not optional.
- The `policies_type_check` fix is unconditionally correct regardless of
  this ADR's own floor-validation feature - even without ADR-0101, a
  freshly-migrated database could not have accepted an `EmploymentPolicy`
  write of any kind. Worth flagging to whoever owns Module 01/02's own
  migration history, since three separate migrations touching the same
  constraint without ever reading each other's list is the root cause, not
  a one-off mistake.
- No RBAC/permission check gates who may call `createEmploymentPolicy` any
  differently than before this ADR - unchanged from the existing posture.
