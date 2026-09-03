# Module 08 Phase 4 Production Readiness Checklist

## Delivered in this phase (application code, across three services)

- [x] **Module 08**: `ComplianceRuleGrpcController` (`GetActiveRule`/
      `ValidatePolicyAgainstFloor`), `compliance.proto`, this service's
      first gRPC server (`main.ts` hybrid transport). Both RPCs reuse
      `ComplianceRuleService`/`resolveEffectiveRules` - no parallel
      implementation. `validate-policy-against-floor.ts`: a real,
      disclosed, per-`ruleType` field-direction comparator, covering all
      four rule types with an EmploymentPolicy counterpart (`break_requirement`
      deliberately has none - no EmploymentPolicy equivalent exists).
      25 new unit tests (comparator: 14, gRPC controller: 9,
      `getActiveRule`: 2) - 77 total in this service.
- [x] **Module 02 (root)**: `ComplianceGrpcClientModule`/`Service` (root's
      first outbound gRPC client of any kind), `EmploymentPolicyViolatesComplianceFloorError`,
      `CreateEmploymentPolicyInput.jurisdiction` (optional), 
      `EmploymentPoliciesService.create`'s write-time gate - fails closed
      on gRPC unavailability, fails open on `floorNotFound`, skips
      (logged) when no jurisdiction is resolvable at all. 8 new unit
      tests.
- [x] **A real, pre-existing bug found and fixed**: `core.policies`'s
      `policy_type` CHECK constraint had drifted to 6 of 11 valid
      `PolicyType` values across three migrations that each replaced the
      whole constraint without reading the others' prior additions - a
      freshly-migrated database rejected every `EmploymentPolicy` write
      outright. Fixed by `1700000011000-PoliciesTypeCheckConsolidationFix.ts`,
      unconditionally correct independent of this phase's own feature work.
- [x] **Module 04 (scheduling-service, Python)**: `calendar_client.py`
      (new - this service's first `CalendarService` consumer, reusing an
      RPC that already existed and already had a consumer elsewhere),
      `compliance_client.py` (new, calling Module 08's new RPC),
      `_merge_compliance_floor` wired unconditionally into `_resolve_policy`,
      stricter-wins-per-field (`_stricter_lower`/`_stricter_higher`), fails
      closed via the existing `_call_upstream` wrapper. Regenerated
      `compliance_pb2*`/`calendar_pb2*` stubs via this service's own
      established `grpc_tools.protoc` convention, with the same
      import-line hand-fix every prior regen of a cross-repo proto needed.
      20 new unit tests (calendar client: 2, compliance client: 3, merge
      logic: 8, helper functions: 9 parametrized cases) - 117 total in
      this service. `pyproject.toml`'s mypy override list gained both new
      client modules.
- [x] **Full three-service E2E verification against real, running
      processes** - not mocks, not unit tests alone: a real `ComplianceRule`
      floor seeded through Module 08's GraphQL API; a real
      `createEmploymentPolicy` GraphQL call through root correctly
      rejected for violating it, correctly accepted for meeting it,
      correctly accepted (fail-open) for a jurisdiction with no seeded
      floor, and correctly rejected (fail-closed, clean error, not a
      silent pass-through) when Module 08's gRPC server was killed
      mid-verification; scheduling-service's real `calendar_client`/
      `compliance_client`/`_merge_compliance_floor` all exercised against
      the real running core and Module 08 processes together (channel
      singletons pointed at real local ports, not mocked), correctly
      resolving jurisdiction and correctly overriding a looser base policy
      value with the real floor's stricter one.
- [x] Three new ADRs (0100: Module 08's own gRPC signature deviations and
      the comparator's design; 0101: Module 02's write-time gate; 0102:
      Module 04's solve-time merge), each documenting a real decision this
      phase's implementation forced, not a decision made in the abstract
      beforehand.

## Explicitly NOT done here (needs a later phase)

- [ ] **State/subdivision-level jurisdiction precision anywhere.** Both
      integration points resolve jurisdiction from `OrgUnit.countryCode` -
      country-level only. A tenant wanting "US-CA" precision on the
      Module 02 side must supply `jurisdiction` explicitly; no equivalent
      override exists on the Module 04 solve-input side. Closing this
      requires new schema work on `OrgUnit` itself, out of scope for any
      of the three services touched this phase.
- [ ] **`overtime_threshold` floors are never merged into Module 04's
      `EmploymentPolicy`.** That dataclass has no corresponding field -
      enforced exclusively by Module 02's write-time gate.
- [ ] **No RBAC/permission check on any of the three new gRPC call sites**
      (Module 02's client, Module 04's two clients, Module 08's server).
      Matches this platform's existing posture for every other internal
      gRPC contract - not a gap specific to this phase.
- [ ] **`RuleChangeImpactPreview` - Phase 5,** entirely unbuilt.
      `activateComplianceRule` still does not check for, generate, or
      require one.
- [ ] **`generateComplianceReport`, the retention lifecycle job** - Phases
      6/7, unaffected by and unrelated to this phase's work.
- [ ] **`ComplianceGrpcClientUnavailableError` (root) is not itself a
      `DomainError` subclass** - it currently surfaces as a generic 500/
      `INTERNAL_SERVER_ERROR` rather than a clean typed error code. The
      fail-closed *behavior* is correct and verified; the error's own
      shape is a minor, disclosed polish gap, not a correctness one.
- [ ] **No alerting on either new governance metric** (`compliance_validate_policy_against_floor_calls_total`'s
      rejection rate, `compliance_impact_preview_flagged_but_activated_total` -
      the latter still unpopulated, since it belongs to Phase 5). Both
      declared in Phase 1; only the first is genuinely recorded into as of
      this phase, and nothing pages on it yet.
