# ADR-0021: gRPC surface - Observable-based server streaming, explicit per-request tenant binding

## Context
§3.3 requires three RPCs for Scheduling/Forecasting: `GetSchedulableEmployees`
(server-streaming, "don't return an unbounded list" for large org units),
`GetEmployeeSkillMatrix` (unary, sparse), `GetWorkingTimeRules` (unary). §3.3's
stated rationale for this boundary - "Scheduling never queries the Employee
database directly" - means this contract needs the same design rigor as a public
API, including how tenant identity crosses it, since there is no HTTP request here
for `TenantContextMiddleware` (ADR-0014) to bind from.

## Decision: `GetSchedulableEmployees` is always server-streaming; large-vs-small org units aren't different code paths
`rpc GetSchedulableEmployees(...) returns (stream SchedulableEmployee)` - a fixed
contract shape, not something that varies by org-unit size (a gRPC method's
streaming-ness is part of its `.proto` definition, not a runtime choice). The
*implementation* internally pages through `EmployeesRepository.findSchedulablePage`
in `pageSize`-sized chunks (client-requested, server-clamped to `MAX_PAGE_SIZE`) and
emits one message per employee. A small org unit just produces a short-lived stream;
a large one produces a longer one - §3.3's "don't return an unbounded list"
requirement is satisfied by the streaming contract itself, not by a size-based
branch.

`EmployeeGrpcController.getSchedulableEmployees` returns an RxJS `Observable` from a
`@GrpcMethod`-decorated handler - the documented NestJS pattern for server-streaming
without needing `@GrpcStreamMethod` (which is for client-streaming/bidirectional,
where the *handler* receives a stream, not just returns one).

## Decision: hard skill-match filter, `HAVING COUNT(DISTINCT skill_id) = required count`
An employee must hold *every* skill in `required_skill_ids` to be schedulable at
all - modeled as a `SELECT ... GROUP BY employee_id HAVING COUNT(DISTINCT skill_id) =
:requiredCount` subquery. This is a hard boolean gate, deliberately independent of
`decay_score` - §2.2 rule 3 is explicit that decay is a solver-side soft-constraint
weight, "never a hard has-skill/doesn't-have-skill boolean." `GetSchedulableEmployees`
*is* that hard boolean; `decay_score` only ever reaches the solver via
`GetEmployeeSkillMatrix`.

## Decision: tenant context is an explicit request field, not ambient
Every request message (`GetSchedulableEmployeesRequest`, `GetEmployeeSkillMatrixRequest`,
`GetWorkingTimeRulesRequest`) carries `tenant_id` explicitly; each gRPC handler
calls `tenantContext.run({ tenantId: request.tenantId }, ...)` itself, the same
explicit-rebinding pattern `SkillDecayJobService`/`BulkImportService` already use
for their own non-HTTP async work (rather than relying on `TenantContextMiddleware`,
which only runs for the Express/HTTP transport). This is the same class of
placeholder ADR-0014 already flagged for HTTP: a real deployment would authenticate
the *calling service* (mTLS client certs, a service-mesh identity, a signed service
token) and derive tenant scope from a validated claim, not trust a client-supplied
field. Internal service-to-service gRPC traffic is lower-risk than public HTTP (the
caller is presumed to be Scheduling/Forecasting, not an arbitrary client), but "lower
risk" is not "no risk," and this is recorded as unfinished, not silently accepted.

## Decision: dynamic proto loading (`@grpc/proto-loader`), no codegen step
`.proto` files are loaded at runtime (`protoPath` in `main.ts`'s
`connectMicroservice` config), not compiled to TypeScript types via `ts-proto` or
similar. This matches NestJS's standard gRPC quickstart and avoids adding a codegen
build step for three RPCs; request/response shapes are plain TS interfaces
hand-written to match the `.proto` field names (camelCased by `proto-loader`'s
default `keepCase: false`). If this contract grows significantly, revisit - hand-kept
interfaces drifting from the actual `.proto` silently is a real risk a codegen step
would close.

## Consequences
- `nest-cli.json` gained an `assets` entry (`grpc/proto/**/*.proto` -> `dist/`) -
  without it, `nest build` (which only compiles `.ts` files) would silently omit the
  `.proto` files the compiled `main.js` needs at runtime, working in `ts-node`
  dev mode but breaking in a built/production artifact. Caught during this phase's
  own build verification, not left as a latent gap.
- "Contract-tested against a mock Module 04 consumer" (§8 Phase 7) is a real
  `@grpc/grpc-js` client with no NestJS involvement on the calling side
  (`test/integration/grpc-employee-calendar.spec.ts`) - as close to a real
  Scheduling/Forecasting caller as this repo can exercise without a second service.
- No gRPC interceptor/auth exists yet - see the tenant-context consequence above.
