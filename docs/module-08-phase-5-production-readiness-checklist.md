# Module 08 Phase 5 Production Readiness Checklist

## Delivered in this phase (application code, across two services)

- [x] **scheduling-service**: `ScheduleQueryService.ListPublishedShiftAssignments`
      (new proto, servicer, `main.py` registration), backed by a new bulk
      query function generalizing the existing single-employee query's
      exact filter. 5 new integration tests (against a real Postgres),
      covering the bulk filter, tenant isolation, empty-input short
      circuit, and the servicer itself (happy path + malformed request).
      One new ADR (0103).
- [x] **Module 08**: `EmployeeGrpcClientService.getSchedulableRoster` (new
      method on the existing client), `ScheduleQueryGrpcClientModule`/
      `Service` and `AuditGrpcClientModule`/`Service` (two new outbound
      clients), `evaluate-schedule-compliance.ts` (real per-`ruleType`
      violation detection, 20 unit tests covering all four checkable rule
      types plus the always-compliant `break_requirement` case),
      `RuleChangeImpactPreviewService` (real simulation orchestration,
      6 unit tests), `generateRuleChangeImpactPreview` GraphQL mutation,
      `activateRule`'s new impact-preview gate + best-effort audit call
      (`ImpactPreviewRequiredError`, 4 new/updated `activateRule` tests +
      3 new `getOwnedRule` tests). One new ADR (0104). 121 total unit
      tests in this service (up from 77).
- [x] **A real, pre-existing local-environment bug found and fixed**:
      `scheduling-service/.env` had drifted from `.env.example` (wrong DB
      port/username/password for this machine's actual Postgres), and
      attendance-leave-service's migrations had never been applied here -
      both blocked this phase's own integration tests (and, it turns out,
      every pre-existing integration test in `scheduling-service` that
      needed a real solve) until fixed for real, not worked around.
- [x] **Full real E2E verification against real, running processes** -
      not mocks: a real published schedule (via a real CP-SAT solve) with
      a deliberately-insufficient rest gap; a real `ComplianceRule` created
      and correctly blocked from activation with no preview; a real
      cross-service simulation (`Module 08 → core.EmployeeService →
      Module 08 → scheduling-service.ScheduleQueryService`) correctly
      computing `wouldBecomeNoncompliantCount: 1`; activation correctly
      succeeding anyway (advisory) and writing a real row into core's
      `audit_log` plus incrementing the real governance metric; a second,
      compliant rule correctly producing zero count and zero audit noise;
      and scheduling-service killed and confirmed down before a third
      preview attempt correctly failed closed with a clean error. All
      test data and processes cleaned up afterward.

## Explicitly NOT done here (needs a later phase, or is a disclosed gap)

- [ ] **`generateComplianceReport`, the retention lifecycle job** - Phases
      6/7, unrelated to and unaffected by this phase's work.
- [ ] **Jurisdiction/org-unit-scope precision** - unchanged from
      ADR-0101/0102's own disclosed limit; this phase reuses the same
      caller-supplies-the-scope posture rather than improving it.
- [ ] **No RBAC/permission check on `generateRuleChangeImpactPreview` or
      either new gRPC client's calls** - matches this platform's existing
      posture for every other internal gRPC contract, not a gap specific
      to this phase.
- [ ] **Simulation coverage is partial by design**: `union_rule`'s
      mandatory-break fields and `overtime_threshold`'s `multiplier` field
      are validated at the Module 02 write-time gate (ADR-0101) but never
      simulated here - no schedule-derivable signal exists for either.
- [ ] **`ScheduleQueryGrpcClientUnavailableError` is not a `DomainError`
      subclass** - surfaces as a generic 500 rather than a typed error
      code. The fail-closed *behavior* is correct and verified for real;
      the error's own shape is a minor, disclosed polish gap, matching the
      identical gap Phase 4's checklist already flagged for
      `ComplianceGrpcClientUnavailableError` on the root side - neither has
      been fixed yet.
- [ ] **No alerting on `compliance_impact_preview_flagged_but_activated_total`** -
      populated for the first time this phase, but nothing pages on its
      rate yet.
- [ ] **The 28-day simulation window is fixed, not caller-configurable** -
      a real, disclosed default; a tenant needing a longer or shorter
      lookahead has no override today.
