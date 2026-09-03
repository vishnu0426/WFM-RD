# ADR-0120: `ReallocationService` — intraday-service's first-ever gRPC server, exposing `ReallocationAction` by id and by period

## Context
Phase 4's `explainReallocation(reallocationActionId)` needs Module 05's `ReallocationAction` data - `ai_rationale` (ADR-0070) already holds real, deterministic, metrics-citing data (trigger metric, queue service levels). Checking intraday-service's real cross-module surface first: it has gRPC **clients** (to Module 01/02/04, e.g. `ScheduleServiceClient`) but **no gRPC server of any kind** - every prior cross-module interaction involving Module 05 has gone the other way. `pendingReallocations` (GraphQL, status-filtered list) and the REST approval endpoint are this service's only existing read/write surfaces for this entity, neither gRPC.

## Decision
Add `agno.intraday.v1.ReallocationService` - this service's first gRPC server, using `@nestjs/microservices`' `@GrpcMethod` (unary, dynamically-loaded `.proto`, no code generation step - the same mechanism `adherence-compliance-service`'s `ComplianceRuleGrpcController` already uses, distinct from the Python services' `grpc.aio`+generated-stub approach). Two RPCs:

- `GetReallocationForExplanation(tenantId, reallocationActionId)` - single-row lookup, `ReallocationQueryService.getById` (new - `listPendingReallocations`'s existing method is status-filtered, not suitable for looking up a specific, possibly-already-decided action).
- `ListReallocationsForPeriod(tenantId, periodStart, periodEnd)` - see ADR-0122 for why this exists and its own scope limitation.

Wired via `app.connectMicroservice` in `main.ts` (a second transport on the same `INestApplication`, same pattern as `adherence-compliance-service`'s `main.ts`) and a new `nest-cli.json` `assets` entry to copy the `.proto` file into `dist/`. New port: `GRPC_URL ?? '0.0.0.0:7200'` (7000/7100 already taken by attendance-leave-service/adherence-compliance-service).

## Consequences
- intraday-service gains its first `@nestjs/microservices`/`@grpc/grpc-js`/`@grpc/proto-loader` dependencies and its first gRPC surface - a genuinely new capability class for this service, not an incremental addition to an existing one.
- **Verified for real**: a live boot (real Postgres, real Redis, real NATS all reachable in this session) with a seeded `reallocation_action` row, called over a real gRPC socket with a real `@grpc/grpc-js` client - both RPCs returned exactly the seeded data, including the wrong-tenant `found: false` case. All 180 pre-existing unit tests still pass; 9 new tests added for the query-service/controller logic (189/189 total).
- **A real, pre-existing bug found in this service, disclosed, not fixed here**: `INestApplication.close()` does not resolve once this service has called `app.listen()` (HTTP) - reproduced with a minimal script that adds nothing from this phase at all (no gRPC, no new code). This is intraday-service's own graceful-shutdown behavior, orthogonal to this ADR's own change (confirmed by reproducing it without the new gRPC transport connected), and out of this phase's scope to fix. Flagged in the Phase 4 readiness checklist, not silently worked around.
