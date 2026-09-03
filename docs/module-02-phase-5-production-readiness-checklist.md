# Module 02 Phase 5 Production Readiness Checklist

Extends the Phase 1-4 checklists.

## Delivered in this phase

- [x] REST `POST /v1/calendars` (create/update, keyed by `orgUnitId`).
- [x] GraphQL `workingTimeCalendar(orgUnitId)` query.
- [x] GraphQL `employmentPolicies(orgUnitId)`, `employmentPolicy(policyGroupId, asOf)`
      queries; `createEmploymentPolicy` mutation (new lineage or new version,
      ADR-0018).

## Explicitly NOT done here

- [ ] **`WorkingTimeCalendar.timezone` IANA validation.** Unvalidated at input time;
      relies on the Phase 4 scheduler's own safe-fallback behavior. A bad value
      degrades to "this tenant's decay job runs on UTC," not a crash, but is not
      caught at write time.
- [ ] **ABAC.** Same standing gap (ADR-0014) - `employmentPolicies`/`workingTimeCalendar`
      are tenant-scoped only, no per-role org-unit restriction.
- [ ] **`EmploymentPolicy` evaluation logic** (e.g. actually applying an
      `overtime_threshold` policy to a timesheet). This phase only makes policies
      readable/writable - nothing in this repo evaluates them against real data yet
      (that's Scheduling/Module 04's job, via the gRPC contracts Phase 7 hasn't
      built).
