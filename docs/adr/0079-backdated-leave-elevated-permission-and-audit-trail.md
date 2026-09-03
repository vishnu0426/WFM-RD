# ADR-0079: Backdated leave gets its own submission mutation, its own RBAC permission, and a real audit trail into Module 01's AuditLog

## Context
Module 06's §5.1 flags backdated/retroactive leave entry as a risk to build
now, not defer, for three reasons: it has direct payroll/compliance
implications a normal forward-dated request doesn't; it needs a mandatory
reason and a distinct, elevated approval requirement (not the ordinary
leave-approver permission); and its `AuditLog` entry must capture the delta
it creates, flagging explicitly whether a payroll resync (Module 12) is
required.

Phase 3 already anticipated this: `requestLeave` rejects any past
`dateRangeStart` outright (`BackdatedLeaveNotSupportedError`), and the
Phase 1 schema already shaped `is_backdated`/`backdated_reason`/
`backdated_approved_by` columns on `LeaveRequest` rather than retrofitting
them later. This phase builds the other half: the dedicated submission
path, the permission gate on approving it, and the audit call.

## Decision

**`submitBackdatedLeave`** (`POST /v1/leave/backdated-requests`,
`LeaveRequestService.submitBackdatedLeave`) is a separate method and REST
route, not an overload of `requestLeave` - §3.1's own reasoning ("so the
stricter audit path can't be accidentally skipped"). It rejects a
`dateRangeStart` that is *not* in the past (`NotActuallyBackdatedError`,
directing the caller to `requestLeave`) - the mirror image of
`requestLeave`'s own rejection, so the two mutations' input domains are
disjoint by construction. `backdatedReason` is mandatory
(`@IsNotEmpty`). It reuses `LeaveRequestService.reserveAndSubmit`'s
row-locking/balance-reservation logic via a new `options` parameter
(`forcePending`, `isBackdated`, `backdatedReason`) rather than duplicating
it - the concurrency-critical part of this flow has exactly one
implementation. `forcePending: true` means a backdated entry always
requires a human decision, even against a `LeaveType` configured with
`requiresApproval: false`: §5.1's own framing (payroll/compliance
implications a normal request doesn't have) is reason enough that a leave
type's auto-approval setting shouldn't extend to a backdated claim against
it.

**The elevated permission**: `backdated_leave_entry` is added to Module
01's RBAC `RESOURCES` catalog (root `src/database/seeds/run-seed.ts`), a
resource distinct from `leave_request` precisely so
`backdated_leave_entry:approve` is its own grantable permission, not a
side effect of holding the ordinary leave-approver permission (§5.1: "a
new granular permission in Module 01's RBAC, not reuse of the standard
leave-approver permission"). This service has no JWT/session verification
of any kind (true since Phase 1 - every actor-identifying field in this
module, `employeeId`/`decidedBy`, is client-supplied and trusted as-is).
`DecideLeaveRequestDto.actorPermissions` extends that same posture rather
than inventing a new one: a flat, client-asserted permission-string array,
checked (and required) only when the `LeaveRequest` being decided is
`is_backdated` and the decision is `approved` - rejecting a backdated
request needs no elevated permission, since only approval carries the
payroll/compliance implication. The check runs in
`DecideLeaveRequestService.applyDecision` right after the `LeaveRequest`
row is locked and its `isBackdated` flag is known, but *before* the
`LeaveBalance` row is locked - a denial never acquires a lock it won't
use. On approval, `backdatedApprovedBy` is set to the same actor as
`decidedBy` - there is no separate co-signer role in this phase, so the
elevated-permission holder who approved it and the ordinary "who decided
this" field record the same person.

**The audit trail**: `AuditGrpcClientService`
(`attendance-leave-service/src/grpc/`) is this service's first gRPC
*client* (Phase 5 only ever made it a gRPC *server*) - a thin
`@nestjs/microservices` `ClientGrpc` wrapper around core's own
`AuditService.RecordEvent` (`src/grpc/controllers/audit-grpc.controller.ts`,
already built and already durable per ADR-0042: `RecordEvent` inserts into
`core.pending_audit_events` before returning, flushed into
`core.audit_log` on a 2-second cron with retry/DLQ). `protoPath` resolves
core's checked-in `audit.proto` from `process.cwd()`, not `__dirname` -
this service does not keep its own copy (the same "single source of
truth, no duplicate proto" posture ADR-0078 already established for
scheduling-service pointing at *this* service's `leave.proto`), and
`process.cwd()` is stable across `ts-node` dev mode and a production build
in a way a `__dirname`-relative offset is not (see the module's own doc
comment for the full reasoning).

Every decided (`approved` or `rejected`) backdated `LeaveRequest` gets a
`RecordEvent` call after the decision transaction commits -
`DecideLeaveRequestService.auditBackdatedDecision`, same best-effort,
after-commit posture as the existing NATS publish (`publishApproval`).
This is not a shortcut: `audit.proto`'s own header comment documents
`RecordEvent` as "fire-and-forget from every service" by design, so
treating a transport failure as non-fatal to the decision itself is the
*correct* posture, not a deviation from one. A failure is logged at ERROR
(not WARN, unlike the NATS publish) and counted
(`leave_backdated_audit_events_total{result="failed"}`) given this is a
compliance record, not a proactive-refresh optimization.

**The payroll-resync flag**: §5.1 requires the audit entry to "capture the
delta this creates against any already-processed attendance/payroll data
for that period" and to "flag explicitly if a backdated approval requires
re-triggering a payroll integration sync (Module 12)." No payroll system
exists anywhere in this platform (Module 12 is unbuilt) to diff against -
there is no "already-processed payroll data" to read, and no endpoint to
call. What is actually recorded is the honest, buildable interpretation:
`beforeStateJson`/`afterStateJson` capture the delta this decision creates
in this module's own state (pending reservation -> approved/rejected), and
`afterStateJson.payrollResyncRequired` is `true` on approval, `false` on
rejection - only an approved backdated entry changes committed
`used_days`, which is the condition under which a payroll system would
need to know. This satisfies §5.1's "flag explicitly" instruction as data
on the audit event itself; a future phase adding real Module 12
integration should treat this flag as its trigger condition, not
re-derive it.

## Consequences
- `attendance-leave-service` gains its first gRPC client dependency on
  core (`CORE_GRPC_URL`, default `localhost:5000` matching core's own
  server default) - a new runtime dependency for the decision path of any
  backdated request, though not for the ordinary `requestLeave`/
  `decideLeaveRequest` paths, which never call it.
- A genuine bug was caught by this phase's own real-build verification
  (`node dist/src/main.js`), not by unit tests: `AuditGrpcClientModule`
  and `AuditGrpcClientService` originally imported a shared token constant
  from each other's file, and Nest's DI container failed at boot with "a
  circular dependency has been detected inside AuditGrpcClientModule."
  Fixed by extracting the token to its own file
  (`audit-grpc-client.constants.ts`). No unit test could have caught this
  - `audit-grpc-client.service.spec.ts` constructs the service directly
  and never loads either module file, and NestJS's DI graph is only
  assembled at real application bootstrap.
- `BackdatedLeaveNotSupportedError`'s message text (Phase 3) referenced
  `submitBackdatedLeave` as "not yet available (Phase 6)" - now stale
  since this phase ships it. Updated in place (not a new error class) to
  point at the real endpoint; this is a message-text correction, not a
  behavior change, and needed no new migration or ADR of its own.
- Every existing `requestLeave`/`decideLeaveRequest` call site is
  unaffected: `reserveAndSubmit`'s new `options` parameter defaults every
  existing call site to `{ forcePending: false, isBackdated: false,
  backdatedReason: null }` (`requestLeave`'s own call site), and
  `DecideLeaveRequestDto.actorPermissions` is optional - an ordinary,
  non-backdated decision never checks it and never calls the audit client.
