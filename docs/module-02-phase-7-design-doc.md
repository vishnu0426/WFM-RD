# Module 02 Phase 7 Design Doc — gRPC Surface for Scheduling/Forecasting

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §3.3/§8 Phase 7 - `EmployeeService.GetSchedulableEmployees` (streaming),
`EmployeeService.GetEmployeeSkillMatrix`, `CalendarService.GetWorkingTimeRules`,
contract-tested against a mock Module 04 consumer.

## Decision

A new top-level `GrpcModule` (`src/grpc/`), not nested under `src/modules/` - it's a
transport/composition layer over existing repositories
(`EmployeesRepository`/`EmployeeSkillsRepository`/`WorkingTimeCalendarsService`),
not a bounded-context module of its own. `main.ts` runs it as a second transport
(`app.connectMicroservice` + `startAllMicroservices()`) alongside the existing
HTTP/GraphQL app, on `GRPC_URL` (default `0.0.0.0:5000`). See ADR-0021 for the
streaming pattern, the hard-skill-filter semantics, and the explicit
per-request tenant binding.

## Explicit assumptions

1. **`GetSchedulableEmployees` is unconditionally server-streaming** - the
   spec's "large vs. small org units" language describes the internal paging
   behavior, not a runtime choice of RPC shape. See ADR-0021.
2. **Tenant context travels as an explicit `tenant_id` request field**, bound
   per-call the same way `SkillDecayJobService`/`BulkImportService` already bind it
   for non-HTTP work - no gRPC interceptor/auth exists (same standing placeholder
   posture as ADR-0014, now extended to this transport).
3. **Dynamic proto loading, no codegen.** See ADR-0021.
4. **`decay_score` is never a filter in `GetSchedulableEmployees`** - only skill
   *possession* gates results; decay reaches the solver exclusively via
   `GetEmployeeSkillMatrix`, per §2.2 rule 3.

## Out of scope for this phase

- GDPR erasure workflow, observability/hardening (Phase 8).
- A real Module 04 (Scheduling) consumer - this phase's own integration test is the
  closest available substitute.
- gRPC auth/mTLS.
