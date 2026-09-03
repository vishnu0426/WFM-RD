# Module 08 Phase 5 Design Doc — Adherence & Compliance: Rule Change Impact Preview

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08), plus a small additive
change to Module 04 (`scheduling-service/`, Python) - a new bulk gRPC read
RPC, not a change to its own request path or solver.
**Scope:** §7's own Phase 5 line: "`RuleChangeImpactPreview`'s real
simulation logic (re-running the constraint check against published
schedules) and the `AuditLog` entry for 'activated despite flagged
non-compliance'" (Phase 1 design doc's own "out of scope" note, carried
forward verbatim as this phase's scope). Both pieces shipped: the real
simulation (ADR-0103/0104) and the `activateRule` gate + best-effort audit
trail (ADR-0104).

## Problem

Three real gaps, each requiring a decision before writing any code:

1. **No bulk read of published shift assignments exists anywhere.** The
   only contract is scheduling-service's single-employee REST endpoint
   (ADR-0064), and there is no precedent anywhere in this platform for a
   Node service calling another service's REST API. See ADR-0103: a new
   gRPC RPC on scheduling-service, mirroring its own existing
   `SchedulingEligibilityService` server pattern.
2. **`ComplianceRule` has no org-unit scope** - only `jurisdiction`. There
   is no RPC anywhere that maps a jurisdiction to a set of org units, and
   building one would be new scope in Module 02's own domain. See
   ADR-0104: the caller supplies `orgUnitIds` directly, the same posture
   ADR-0101/0102 already took for jurisdiction resolution.
3. **"Would become non-compliant" needed a precise, disclosed definition** -
   built as "compliant under whatever rule is *currently active* for this
   jurisdiction/ruleType (or no constraint, if none is active) AND
   non-compliant under the *candidate* rule being previewed." Not "is
   anyone non-compliant under the proposed rule outright."

## Decision

**scheduling-service** (ADR-0103): `ScheduleQueryService.ListPublishedShiftAssignments`
- a second gRPC server surface, server-streaming, backed by a new bulk
query function (`list_shift_assignments_for_employees`) that generalizes
the existing single-employee query's exact filter (published-only,
window-overlap) to an `employee_id IN (...)` list.

**Module 08** (`adherence-compliance-service/`):
- `EmployeeGrpcClientService` gains `getSchedulableRoster` (own copy of
  shift-marketplace-service's identical method, same `EmployeeService`
  client binding this service already had).
- New `ScheduleQueryGrpcClientModule`/`Service` (→ scheduling-service) and
  `AuditGrpcClientModule`/`Service` (→ core's `AuditService.RecordEvent`,
  ADR-0079's third adopter).
- New `evaluate-schedule-compliance.ts`: real, disclosed per-`ruleType`
  violation detection against concrete shift timestamps - covers
  `overtime_threshold`, `rest_period_minimum`, `max_consecutive_days`
  fully, `union_rule`'s shift-length fields only, `break_requirement` not
  at all (no schedule-derivable signal for any of it).
- New `RuleChangeImpactPreviewService.generatePreview(tenantId, ruleId,
  orgUnitIds)`: resolves the roster, pulls a 28-day forward window of
  published assignments, compares baseline vs. candidate per employee,
  persists a `RuleChangeImpactPreview` row. Exposed as
  `generateRuleChangeImpactPreview` (GraphQL-only mutation, matching
  `createComplianceRule`/`activateComplianceRule`'s own precedent).
- `ComplianceRuleService.activateRule` now requires at least one preview
  to exist for the rule being activated (`ImpactPreviewRequiredError`
  otherwise) - advisory, not a hard gate: a flagged preview
  (`wouldBecomeNoncompliantCount > 0`) does not block activation, but
  fires a best-effort audit event (`compliance_rule_activated_despite_noncompliance`)
  after the activation transaction commits, and increments
  `compliance_impact_preview_flagged_but_activated_total` (declared
  Phase 1, populated for the first time in this phase).

## Blast radius
- **scheduling-service**: new `app/grpc/proto/schedule_query.proto`,
  `schedule_query_grpc_server.py`, a new function on `schedule_service.py`,
  `main.ts`… `app/main.py` additive registration. One new ADR (0103). Also:
  this local dev environment's `.env` had drifted from `.env.example`
  (wrong DB port/credentials) and attendance-leave-service's migrations had
  never been applied on this machine - both fixed for real (not worked
  around) since they blocked this phase's own verification.
- **Module 08**: new `src/grpc/schedule-query-grpc-client.*`,
  `src/grpc/audit-grpc-client.*`, `src/compliance/impact-preview/*` (new
  directory), `EmployeeGrpcClientService`/`ComplianceRuleService`/
  `ComplianceModule`/`compliance-rule.resolver.ts`/`types.ts` additive
  changes. One new error class
  (`ImpactPreviewRequiredError`). One new ADR (0104).
- Zero changes to any other module's request path, schema, or running
  code - scheduling-service's own solve pipeline is untouched; the new RPC
  is a pure additional read surface.

## Verification

Real, running processes for every claim below - core (gRPC `:5099`, host
quirk override for macOS AirPlay on `:5000`), attendance-leave-service
(gRPC `:7099`, same reason), scheduling-service (`:8100`/`:8102` + a real
worker subprocess), and Module 08 (`:8500`/gRPC `:7100`), all against the
real local Postgres:

- A real tenant/org unit/employee seeded directly in `org.*`; a real
  CP-SAT solve submitted and published through scheduling-service's own
  REST API, producing two real `ShiftAssignment` rows with an 8-hour gap
  between them.
- A real `ComplianceRule` (`US`, `rest_period_minimum`, 10h floor) created
  through Module 08's GraphQL API. `activateComplianceRule` called before
  any preview existed → correctly rejected with `IMPACT_PREVIEW_REQUIRED`.
- `generateRuleChangeImpactPreview` called for real, against the real
  published schedule → correctly returned `wouldBecomeNoncompliantCount: 1`
  (the 8h gap violates the 10h floor, and no baseline rule was active, so
  the employee counted as newly affected), with the real employee id, org
  unit id, and schedule id all present in the response.
- `activateComplianceRule` called again → succeeded (status `active`,
  advisory, not blocked) - and a real row appeared in core's
  `core.audit_log` with `action: 'compliance_rule_activated_despite_noncompliance'`
  and the correct `after_state`, and `/metrics` on Module 08 showed
  `compliance_impact_preview_flagged_but_activated_total 1`.
- A second, looser rule (5h floor, compliant) → preview correctly returned
  `wouldBecomeNoncompliantCount: 0`; activating it did **not** add a second
  audit row or increment the metric further - confirming the "advisory,
  silent when not flagged" branch is genuinely conditional, not always-on.
- Scheduling-service killed and confirmed fully down (port closed, `nc`
  connection refused) before retrying `generateRuleChangeImpactPreview` on
  a third rule → correctly threw a clean `ScheduleQueryGrpcClientUnavailableError`,
  confirming fail-closed behavior under a genuinely unavailable dependency
  (an earlier attempt during scheduling-service's own 5-second gRPC-server
  shutdown grace period spuriously succeeded - not a defect in this
  module's own code, a timing artifact of the verification script itself,
  corrected by waiting for the port to actually close before retrying).
- All test data (tenant, org unit, employee, schedule rows, compliance
  rows, audit row) deleted afterward; all four processes killed and ports
  confirmed free.
- Full suites re-run clean: Module 08 121 unit tests, scheduling-service
  117 unit tests + 5 new integration tests (173 total passing, 4
  pre-existing/unrelated errors in a different test file needing core's
  own DB fixture), root's monorepo-wide `npm test` 111 suites/609 tests.

## Explicit assumptions (spec was ambiguous or silent here)
1. **`orgUnitIds` is caller-supplied, not resolved from the rule's own
   `jurisdiction`** - `ComplianceRule` has no org-unit scope, and no RPC
   exists to map jurisdiction → org units. See ADR-0104.
2. **"Would become non-compliant" = compliant under the baseline AND
   non-compliant under the candidate** - not "non-compliant under the
   candidate" outright. An employee already non-compliant today doesn't
   count as newly affected by *this* change.
3. **A flagged preview is advisory, never a hard activation gate** -
   distinct from `ValidatePolicyAgainstFloor` (ADR-0100), which does
   reject. §5a frames impact preview as visibility/governance, not a
   second legal-floor check.
4. **The simulation window is a fixed 28 days forward from today** - a
   real, disclosed default, not derived from anything in the module
   prompt.
5. **Simulation coverage is partial and disclosed**: `overtime_threshold`/
   `rest_period_minimum`/`max_consecutive_days` fully; `union_rule`'s
   shift-length fields only; `break_requirement` not at all - no
   schedule-derivable signal exists for break-taking.

## Out of scope for this phase (do not build yet)
- `generateComplianceReport`, the retention lifecycle job - Phases 6/7.
- State/subdivision-level jurisdiction precision, RBAC on any gRPC call
  site - pre-existing, disclosed platform-wide gaps this phase does not
  close.
- `ScheduleQueryGrpcClientUnavailableError` becoming a proper `DomainError`
  subclass - currently surfaces as a generic `INTERNAL_SERVER_ERROR`, same
  disclosed polish gap Phase 4's checklist already flagged for
  `ComplianceGrpcClientUnavailableError` on the root side.
