# Module 02 Phase 7 Production Readiness Checklist

Extends the Phase 1-6 checklists.

## Delivered in this phase

- [x] `EmployeeService.GetSchedulableEmployees` (server-streaming, internally
      paginated, hard skill-match filter via `HAVING COUNT(DISTINCT skill_id) =
      required count`).
- [x] `EmployeeService.GetEmployeeSkillMatrix` (sparse, sourced from
      `EmployeeSkillsRepository.findForEmployees`).
- [x] `CalendarService.GetWorkingTimeRules` (holidays filtered to the requested
      date range, business hours JSON-encoded).
- [x] `nest-cli.json` asset copying for `.proto` files, verified against an
      actual `nest build` output, not just `ts-node`.
- [x] Contract test against a real `@grpc/grpc-js` client (no NestJS on the
      calling side) - the closest available stand-in for "a mock Module 04
      consumer" (§8).

## Explicitly NOT done here

- [ ] **No gRPC authentication/authorization.** `tenant_id` is trusted verbatim
      from the request message - the same standing placeholder posture as HTTP
      (ADR-0014), now also true for internal service-to-service traffic. A real
      deployment needs mTLS or a service-mesh identity before Scheduling/Forecasting
      actually call this.
- [ ] **No `EmployeeService`/`CalendarService` deprecation tooling.** §3.3 asks
      for "the same deprecation discipline as a public API change" for these
      `.proto` files - nothing enforces that mechanically (no buf/protobuf
      breaking-change linter wired into CI) yet.
- [ ] **§0.5's `GetSchedulableEmployees` p99 < 100ms SLO is not load-tested.**
      The query is indexed (`idx_employees_tenant_id_org_unit_id`,
      `idx_employees_tenant_id_status`) and streaming avoids building the full
      result set in memory, but no load test has run against this module's
      stated 10M-employee capacity target.
- [ ] **No real Module 04 (Scheduling) consumer exists to validate against** -
      this phase's own contract test is a reasonable stand-in, not a
      substitute for an actual cross-team integration test once Module 04 exists.
