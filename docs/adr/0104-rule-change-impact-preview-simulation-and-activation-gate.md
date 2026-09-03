# ADR-0104: `RuleChangeImpactPreview`'s real simulation, the `activateRule` gate, and the flagged-activation audit trail

## Context
§5a flags `RuleChangeImpactPreview` as a real, must-build-now governance
feature, not a placeholder: "re-run the constraint check against
currently-published schedules" before a compliance rule goes live, so an
admin activating a stricter rule can see who it would newly affect. Phase 1
built the schema and entity comment ("computed by re-running the relevant
constraint check... real logic lands in Phase 5") but deliberately left the
logic itself, and `activateRule`'s own gate, unbuilt.

Three real gaps needed a decision before any code could be written:

1. **`ComplianceRule` has no org-unit scope** - only `jurisdiction` (a
   country/subdivision code). There is no existing RPC anywhere in this
   platform that maps a jurisdiction to a set of org units, and building
   one would be new scope in Module 02's own domain, not this module's
   (§8: "not rewriting Module 02/04's own internal logic beyond the
   integration points").
2. **No bulk read of published shift assignments exists** - closed by
   ADR-0103 (scheduling-service's new `ScheduleQueryService`).
3. **What does "would become non-compliant" mean precisely** - non-compliant
   under the proposed rule outright, or newly non-compliant relative to
   today's actual enforcement? The entity's own field name
   (`wouldBecomeNoncompliantCount`, not `nonCompliantCount`) states the
   latter, but nothing forces that reading without a real baseline
   comparison.

## Decision

**Scope is caller-supplied, not resolved.** `generateRuleChangeImpactPreview(ruleId,
orgUnitIds)` (GraphQL-only, matching `createComplianceRule`/`activateComplianceRule`'s
own GraphQL-only precedent) takes `orgUnitIds` directly - the caller (an
admin UI that already manages org units) supplies the scope, the same
posture ADR-0101/0102 already took for jurisdiction resolution on the
Module 02/04 integration points. `RuleChangeImpactPreviewService` resolves
each org unit's roster via `EmployeeGrpcClientService.getSchedulableRoster`
(new method, own copy of shift-marketplace-service's identical one - same
client binding as the existing `EmployeeService` package, not a new
`ClientsModule` registration), dedupes employee ids across org units, pulls
every employee's published shift assignments over a fixed 28-day forward
window via `ScheduleQueryGrpcClientService` (ADR-0103), and evaluates each
employee's shift set against both the **candidate** rule (the one being
previewed) and the **baseline** (`ComplianceRuleService.getActiveRule` for
the same jurisdiction/ruleType, or "no constraint" if none is currently
active).

**"Would become non-compliant" = compliant under the baseline AND
non-compliant under the candidate.** An employee already non-compliant
today (or who has no baseline rule at all to be compliant against) is
non-compliant either way, so does not count as newly affected by *this*
change - the metric is about this rule change's own incremental impact,
not a general compliance audit (that is Phase 6's `generateComplianceReport`).

**The comparison logic** (`evaluate-schedule-compliance.ts`) is a real,
disclosed re-expression of each rule type's arithmetic against concrete
shift timestamps - the same posture scheduling-service's own
`app/solver/eligibility.py` took for evaluating CP-SAT constraints without
a solver. Bucketed by UTC calendar day, not the employee's own timezone -
acceptable for a preview (never gates a real schedule); Phase 3's rollup
remains the authoritative timezone-aware computation. Coverage is
disclosed, not silently partial: `overtime_threshold` (daily/weekly hour
sums), `rest_period_minimum` (gap between consecutive shifts),
`max_consecutive_days` (sliding-window worked-day count, same window
formula as `eligibility.py`'s), and `union_rule`'s shift-length fields
only (`minShiftLengthMinutes`/`maxShiftLengthMinutes` - break-related
fields have no schedule-derivable signal, `ShiftAssignment` records
start/end only). `break_requirement` is always compliant - no signal
exists to evaluate it against at all.

**`activateRule` now requires at least one `RuleChangeImpactPreview` row
for the rule being activated** - "only after the admin has reviewed a
RuleChangeImpactPreview" (`compliance-rule.entity.ts`'s own Phase 1
comment), enforced as "one exists" (queried inside the same transaction,
immediately before the supersede/update calls), not merely "the caller
claims to have looked." Missing preview → `ImpactPreviewRequiredError`,
before any write happens. A **flagged** preview
(`wouldBecomeNoncompliantCount > 0`) does **not** block activation - §5a
frames this as a governance/visibility feature, not a second
`ValidatePolicyAgainstFloor` (ADR-0100). The distinction from a hard gate
is deliberate: a jurisdiction's admin may have a legitimate reason to
tighten a rule despite short-term schedule friction (existing published
schedules simply predate the change), and this module has no authority to
override that judgment call.

**The flagged-but-activated case is recorded as a best-effort audit event**,
fired after the activation transaction has already committed (never
blocks or rolls back an activation that already happened - same posture
ADR-0079's `DecideLeaveRequestService.auditBackdatedDecision` takes for its
own post-commit call). `AuditGrpcClientService`/`AuditGrpcClientModule`
(new in this service, own copy of attendance-leave-service's identical
files) call core's `AuditService.RecordEvent` - this platform's third
adopter of ADR-0079's mechanism, not a new one.
`compliance_impact_preview_flagged_but_activated_total` (declared in
Phase 1, unpopulated since) is incremented in the same branch.

## Consequences
- Module 08 gains its fourth and fifth outbound gRPC clients
  (`ScheduleQueryGrpcClientService` → scheduling-service,
  `AuditGrpcClientService` → core) plus a new method on the existing
  `EmployeeGrpcClientService` - all copies of established platform
  patterns, no new transport or convention introduced.
- `activateComplianceRule` is now a strictly harder call than before this
  phase: every rule, in every jurisdiction, must have a impact preview
  generated first, even one covering zero org units (an admin who
  genuinely has no roster yet to check can still call
  `generateRuleChangeImpactPreview(ruleId, [])`, which legitimately
  produces a zero-count preview and satisfies the gate). This is a real,
  disclosed behavior change for anyone already calling
  `activateComplianceRule` directly - there is no escape hatch, matching
  the mandatory-human-review framing the schema comment already stated
  from Phase 1.
- Jurisdiction/org-unit-scope precision is exactly as coarse as
  ADR-0101/0102 already accepted - this phase does not improve it, only
  reuses the same caller-supplies-the-scope posture.
- `overtime_threshold`'s `multiplier` field and `union_rule`'s two
  mandatory-break fields are validated at the Module 02 write-time gate
  (ADR-0101) but never simulated here - no schedule-derivable signal
  exists for either. Disclosed, not silently dropped.
