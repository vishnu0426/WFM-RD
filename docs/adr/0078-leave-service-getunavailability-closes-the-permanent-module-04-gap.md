# ADR-0078: `LeaveService.GetUnavailability` closes the permanent leave-data gap ADR-0059 documented, with request-supplied-wins-outright pull semantics matching roster/policy

## Context
ADR-0059 (Module 04 Phase 6) made `roster`/`policy`/each shift's
`requiredHeadcount` optional-and-pullable via gRPC, but explicitly left
`leaveRecords` as permanently request-supplied: *"No real leave/
unavailability source exists anywhere in the platform... this is
unchanged by this phase, permanently, until Module 06 ships."* Module 06's
own §3.4 names closing this gap "the real point of this module" and
directs that once the contract exists, scheduling-service's interim stub
should be re-pointed at it as an explicit, tracked follow-up - not an
implicit assumption left for someone to rediscover.

Module 06 Phase 5 is that follow-up landing. This ADR documents both
halves: the new contract Module 06 exposes, and scheduling-service's own
re-pointing to consume it - a cross-repository decision, recorded once at
the repo root (`docs/adr/`, where ADR-0059 itself lives) rather than
split across two service-local ADR directories.

## Decision

**Contract** (`attendance-leave-service/src/grpc/proto/leave.proto`,
package `agno.leave.v1`): a single unary RPC,
`LeaveService.GetUnavailability(tenant_id, employee_ids[], date_range_start,
date_range_end) -> repeated { employee_id, start_date, end_date,
leave_type_id }`. Same shape family as `EmployeeService`/`PolicyService`/
`ForecastService` (§3.3/ADR-0059's precedent): unary, tenant-scoped,
no HTTP middleware binding tenant context (bound per-handler from the
request message, `LeaveGrpcController`'s own doc comment). Unlike
`ForecastService`'s `found: bool` sentinel, an empty `records` list is a
normal response ("no approved leave in this window"), not a not-found
case - there is nothing to be "not found" about a leave-record query.

**Only `status = 'approved'` `LeaveRequest` rows are ever returned** - a
direct, load-bearing consequence of §2.2 rule 2 and ADR-0057's
"never-relaxable" posture for leave/unavailability: scheduling-service
treats every record this RPC returns as an absolute hard constraint, so a
pending or rejected request appearing here would let this module
unilaterally block a shift no human ever actually approved blocking. This
is a `WHERE status = 'approved'` clause in `LeaveGrpcController`, not an
application-level filter applied after the fact - there is no code path
that could return an unapproved request even by a future bug that adds a
new call site.

**scheduling-service's `_resolve_leave_records`** (`app/services/solve_input_resolver.py`)
mirrors `_resolve_roster`/`_resolve_policy` exactly: `ScheduleJobRequest.leave_records`
changes from `list[LeaveRecordInput] = Field(default_factory=list)` to
`list[LeaveRecordInput] | None = None` (the same fix ADR-0059 already
applied to `roster`/`policy` - a bare `list = []` default has no
wire-representable "omitted, please pull" state, since an omitted key and
an explicit empty list both deserialize to `[]`). Explicit value (including
`[]`) wins outright, no merge - the same "a Scheduler exploring a scenario
with a modified list is a legitimate manual override" reasoning ADR-0059
gives for roster/policy, applied consistently rather than inventing a
different semantics for this one field. Scoped to `ReoptimizeScheduleRequest`
excluded: that request type's `leave_records` stays request-supplied-only,
matching ADR-0059 Decision 2's own scoping of the roster/policy pull to
`submit_schedule_job` only - a deliberate boundary, not an oversight, and a
future ADR's decision to make if reoptimize needs it too.

**Push, in addition to pull** (§3.4): `agno.leave.request.approved.v1`
(`attendance-leave-service/src/nats/subjects.ts`), published by
`DecideLeaveRequestService` after a `decideLeaveRequest` transaction
commits with `decision: approved`. This is this service's first NATS
presence of any kind. Deliberately best-effort and non-transactional with
the Postgres decision (`AttendanceLeaveNatsClientService`'s own doc
comment) - the pull path above is unconditionally correct regardless of
whether any given publish succeeds; the push exists purely to close the
propagation-latency gap between "approved" and "the next scheduled solve,"
not as a second source of truth. `Nats-Msg-Id` dedup keyed on
`leaveRequestId` (via JetStream's native `msgID` publish option) - a
decision is recorded at most once (`LeaveRequestAlreadyDecidedError`),
so `leaveRequestId` is already a stable, natural dedup key with no
separate id-generation scheme needed.

**No consumer of this event exists yet, in either repo.** This ADR
establishes the producer and the wire schema; scheduling-service does not
subscribe to it (its own correctness depends on the pull path alone, by
design), and Module 01's AuditLog/notification pipeline consumption named
in §4's architecture description is not built. A future phase adding a
real consumer should reference this ADR for the payload shape rather than
re-deriving it.

## Consequences
- `docs/module-04-phase-6-design-doc.md`/`docs/module-04-phase-8-production-readiness-checklist.md`'s
  own "leave/unavailability remains permanently request-supplied" language
  is now historical, not current - those docs are left unedited as a
  snapshot of what was true when written (same "never rewrite a shipped
  record" posture as not editing an already-applied migration); this ADR
  and Module 06's own Phase 5 docs are the current, correct statement of
  where that gap stands.
- `attendance-leave-service` gains its first gRPC server and first NATS
  client - both genuinely new capabilities for this service, not
  extensions of something Phase 1-4 already had partially built.
- `scheduling-service` gains a fourth gRPC client dependency
  (`attendance_grpc_url`, alongside core/forecasting) and a schema change
  (`leave_records` becomes `Optional`) - existing callers that always
  supply `leaveRecords` explicitly (every prior test, ADR-0059's own
  backward-compatibility reasoning restated) are unaffected; only a caller
  that previously relied on an *omitted* key silently meaning "zero leave
  records" changes behavior, from "zero" to "pulled" - a deliberate
  correctness fix (the prior behavior was itself the permanent-gap
  workaround this ADR closes), not a compatibility break worth preserving.
- §0.5's real SLO (leave-approval → Module 04 visibility, p99 < 2s) is now
  *measurable* on Module 06's own side
  (`attendance_leave_approval_propagation_duration_seconds`, declared
  since Phase 1, wired for the first time this phase) - but only for the
  push path's own latency slice. The pull path's correctness doesn't
  depend on timing at all (every solve calls `GetUnavailability` fresh),
  so "the SLO" as an end-to-end number spanning both this service and
  scheduling-service's own solve-trigger latency is not fully instrumented
  by either service alone - a real gap, flagged rather than claimed closed.
