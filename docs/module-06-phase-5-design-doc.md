# Module 06 Phase 5 Design Doc — Attendance & Leave Management: Module 04 Integration Contract

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1–4. §3.4
frames this phase as "the real point of this module" - closing a gap
scheduling-service's own Phase 6 (ADR-0059) explicitly deferred, by name,
until this module shipped. This phase is a cross-repository change (both
`attendance-leave-service/` and `scheduling-service/`), documented in one
ADR (ADR-0078) at the repo root rather than split across two service-local
ADR sets.
**Scope:** `LeaveService.GetUnavailability` - this service's first gRPC
server, called by scheduling-service's solve-input resolver mid-solve
(§4.3-style pull, ADR-0059's precedent). `agno.leave.request.approved.v1` -
this service's first NATS publish, on `decideLeaveRequest` approval,
best-effort push in addition to the always-correct pull. **Also builds**
the scheduling-service side of the pull: `ScheduleJobRequest.leave_records`
becomes optional/pullable (mirroring `roster`/`policy`, ADR-0059 Decision
2), with a real `leave_client.py` and `_resolve_leave_records` wired into
`solve_input_resolver.py` - not left as a follow-up task for someone else
to remember, per §3.4's own explicit instruction. **Does not build**:
`submitBackdatedLeave` (Phase 6); any real consumer of the NATS event in
either repo (Module 01's AuditLog/notification pipeline, or a
scheduling-service-side subscriber); GraphQL.

## Problem

Three things needed settling, one of them a direct extension of decisions
Phase 1 already made:

1. **§3.4's text names two RPCs but only one belongs to this service.**
   Re-reading §3.4 carefully: `GetUnavailability` is unambiguously this
   module's own contract (Module 04 pulls, Module 06 serves). The second
   named call, `CheckScheduleConflict`, is described as "the synchronous
   call this module makes into Module 04 at leave-request time" - i.e.
   Module 06 is the *caller*, not the server, for that direction. §3.4's
   literal wording labels both under "LeaveService," which would put
   `CheckScheduleConflict` on the wrong side of the boundary if taken at
   face value. Phase 1's design doc already flagged and resolved this
   (explicit assumption 2): the schedule-conflict direction is REST
   (`ScheduleServiceClient`, built in Phase 2/3, since scheduling-service
   exposes no gRPC server), not a second RPC on this service's own
   `LeaveService`. This phase builds only `GetUnavailability` - there is
   no `CheckScheduleConflict` gRPC method anywhere in this repo, by
   design, not omission.
2. **Closing the loop for real, not just flagging it.** §3.4's own closing
   instruction is explicit: "call this out explicitly as a required
   follow-up task when this phase ships, not an implicit assumption
   someone has to remember." scheduling-service already completed all 8 of
   its own phases (`docs/module-04-phase-8-*`) - there is no future Module
   04 phase to carry this forward into. The precedent for a later module
   reaching into an already-shipped one is ADR-0064 (Module 05 adding a
   REST endpoint to scheduling-service for its own needs). This phase
   follows that precedent for the pull direction: both sides are built
   now, in this phase, not just the Module-06-owned half with a checklist
   item pointing at unfinished Module-04-owned work.
3. **`ScheduleJobRequest.leave_records`'s existing type has no
   "omitted, please pull" state.** Unlike `roster`/`policy`
   (`X | None = None`), `leave_records` was `list[LeaveRecordInput] =
   Field(default_factory=list)` - an omitted key and an explicit `[]` both
   deserialize to the same value, so there was no way to express "pull"
   distinctly from "explicitly zero" the way ADR-0059 already solved for
   roster/policy. This phase applies that same fix to `leave_records`
   rather than inventing new semantics.

## Decision

**`LeaveGrpcController`** (`src/grpc/controllers/leave-grpc.controller.ts`):
unary `GetUnavailability`, tenant context bound per-handler
(`this.tenantContext.run({tenantId: request.tenantId}, ...)`, no HTTP
middleware applies to gRPC - ADR-0021's precedent, mirrored from core's
`EmployeeGrpcController`). Queries `LeaveRequest` directly via `DataSource`/
`withTenantConnection` (this service's established no-repository-layer
convention throughout). `WHERE status = 'approved'` is structural, not
applied after the fact - see ADR-0078 for why this is non-negotiable
(ADR-0057's never-relaxable posture).

**`main.ts`** gains `connectMicroservice`/`startAllMicroservices`, mirroring
core `src/main.ts` exactly - gRPC is a second transport on the same
`INestApplication`, not a separate process. `GRPC_URL` defaults to
`0.0.0.0:7000` (core is `:5000`, forecasting-service is `:6000`, no
existing service claims `:7000`). `nest-cli.json` gains the same
`assets`/`protoPath`-copy config core's own `nest-cli.json` already has -
without it, `leave.proto` never reaches `dist/`, and the gRPC server fails
to start in a production build (caught by this phase's own real-build
verification, not left to be discovered later).

**`AttendanceLeaveNatsClientService`** (`src/nats/`): own, independent copy
of intraday-service's `IntradayNatsClientService` (ADR-0039's precedent -
this service's first NATS presence gets its own client, not a shared
one), extended with an optional `msgId` parameter mapped to JetStream's
native `msgID` publish option for `Nats-Msg-Id`-style dedup.
`DecideLeaveRequestService.publishApproval` calls it after the decision
transaction commits, only on `approved`, wrapped in the same best-effort
try/catch posture `approvalQueue.cancelReminder` already established in
Phase 4 - a failed publish logs a warning and does not fail the
`decideLeaveRequest` call, since the pull path is unconditionally correct
without it.

**`_resolve_leave_records`** (`scheduling-service/app/services/solve_input_resolver.py`):
same shape as `_resolve_roster`/`_resolve_policy` - explicit request value
wins outright (including `[]`), `None` pulls via `leave_client.get_unavailability`,
scoped to the solve's already-resolved `employees` roster and
`body.date_range`. `leave_client.py` mirrors `forecast_client.py`'s
structure exactly (`call_with_retry` + dataclass conversion), generating
real stubs via `grpc_tools.protoc` pointed directly at
`attendance-leave-service/src/grpc/proto/leave.proto` (no local proto copy
checked into scheduling-service, matching how employee.proto/policy.proto
are already handled there).

## Blast radius

- New files under `attendance-leave-service/src/grpc/`, `src/nats/`. One
  additive edit each to `main.ts`, `app.module.ts`, `nest-cli.json`,
  `package.json` (four new deps: `@grpc/grpc-js`, `@grpc/proto-loader`,
  `@nestjs/microservices`, `nats`), `.env.example`,
  `scripts/provision-nats-streams.ts` (two new stream entries).
  `DecideLeaveRequestService`/`LeaveModule` gain the NATS client as a new
  dependency - additive constructor parameter, no existing call site's
  behavior changes.
- `scheduling-service/app/config.py` gains `attendance_grpc_url`;
  `channels.py` gains `get_attendance_channel`; new `leave_client.py` +
  generated stubs; `solve_input_resolver.py` gains `_resolve_leave_records`
  and one new call site in `resolve_submit_solve_input`;
  `app/api/v1/schemas.py`'s `ScheduleJobRequest.leave_records` type change
  (`ReoptimizeScheduleRequest.leave_records` deliberately untouched - see
  ADR-0078); `app/solver/types.py`'s `LeaveRecord` docstring updated to
  reflect the gap is closed; `pyproject.toml`'s mypy override list gains
  one module. All 88 existing scheduling-service unit tests pass unchanged
  (verified) - the schema type change is additive for every caller that
  already supplies `leaveRecords` explicitly.
- No Module 01–03/05 file touched.

## Rollback plan

**attendance-leave-service**: revert `GrpcModule`'s import in
`app.module.ts`, the `connectMicroservice` block in `main.ts`, delete
`src/grpc/`, `src/nats/`, the `assets` config in `nest-cli.json`, the four
new `package.json` deps, revert `DecideLeaveRequestService`'s NATS
constructor param and `publishApproval` method. No migration to revert -
this phase added no tables.

**scheduling-service**: revert `ScheduleJobRequest.leave_records` to its
prior `Field(default_factory=list)` default, delete `leave_client.py` and
the generated `leave_pb2*` files, revert `channels.py`/`config.py`/
`solve_input_resolver.py`'s additive changes, revert the `LeaveRecord`
docstring. Nothing depends on the pull path being present - a request that
always supplies `leaveRecords` explicitly (every existing caller) is
unaffected by rolling this back.

Verified against real infrastructure spanning both services, not just
unit tests: a real local Postgres + real local Redis + real local NATS
broker, the actual built `attendance-leave-service` gRPC server, and a
real Python script calling `leave_client.get_unavailability` against that
live server (not a mocked stub) - see the Phase 5 production readiness
checklist for the exact scenarios run.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`CheckScheduleConflict` is not built as a gRPC method on this
   service's `LeaveService`.** Restated from Phase 1's assumption 2, now
   confirmed by this phase's actual build: §3.4's literal grouping of both
   RPCs under "LeaveService" would put the Module06→Module04 direction on
   the wrong side of the client/server boundary. That direction remains
   REST (`ScheduleServiceClient`, Phase 2/3) - already built, unchanged by
   this phase.
2. **`ReoptimizeScheduleRequest.leave_records` stays request-supplied-only,
   not made pullable.** Mirrors ADR-0059 Decision 2's own scoping choice
   for roster/policy (submit-only, not reoptimize). A future phase wanting
   pull-on-reoptimize is a new, separate decision, not an oversight here.
3. **No consumer of `agno.leave.request.approved.v1` exists yet.** §4's
   architecture description names Module 01's AuditLog/notification
   pipeline as an eventual consumer; scheduling-service's own correctness
   deliberately does not depend on consuming it (the pull path is
   sufficient on its own). Building a real consumer is out of this
   phase's scope - the producer and wire schema are what this phase
   commits to.
4. **The propagation-latency SLO (§0.5, p99 < 2s) is measured only for
   the push path's own latency slice on Module 06's side** - not as a
   true end-to-end number spanning scheduling-service's own solve-trigger
   timing, since nothing consumes the event yet to close that loop. See
   ADR-0078's consequences section.

## Out of scope for this phase (do not build yet)

- `submitBackdatedLeave`, the elevated backdated-leave permission - Phase 6.
- Any real NATS consumer, in either repository.
- GraphQL.
- Reoptimize-path leave-record pulling - see explicit assumption 2.
