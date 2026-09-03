# Module 06 Phase 6 Design Doc — Attendance & Leave Management: Backdated Leave Path

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1–5.
**Scope:** `submitBackdatedLeave` (`POST /v1/leave/backdated-requests`) - a
separate mutation from `requestLeave`, per §3.1/§5.1. The elevated
`backdated_leave_entry:approve` permission (new Module 01 RBAC resource),
enforced on approving (not rejecting) a backdated `decideLeaveRequest`
call. A real audit trail into Module 01's `AuditLog` via a new gRPC client
call to core's `AuditService.RecordEvent`, including an explicit
`payrollResyncRequired` flag per §5.1. **Does not build**: GraphQL; a real
Module 12 (payroll) integration - the flag is recorded, nothing consumes
it; multi-level/co-signer approval chains for backdated entries (the same
actor is both `decidedBy` and `backdatedApprovedBy`, restated from Phase
4's single-step-approval-chain assumption).

## Problem

Three things needed a real design, not just a schema column:

1. **Where does the elevated-permission check actually live, given this
   service has no auth of its own?** Every actor-identifying field in this
   module (`employeeId` since Phase 3, `decidedBy` since Phase 4) is
   client-supplied and trusted as-is - there is no JWT verification, no
   session, no RBAC enforcement anywhere in `attendance-leave-service`.
   Building real JWT verification just for this one check would be
   disproportionate to Phase 6's scope and inconsistent with every other
   actor field in this module. The consistent choice is the same one
   already made for `decidedBy`: an explicit, client-supplied field
   (`DecideLeaveRequestDto.actorPermissions`), checked only where it
   matters (approving a backdated request). This is exactly as
   "trust-the-caller" as `decidedBy` already is - not a new, weaker
   posture introduced for this feature, but the existing one applied
   consistently.
2. **Does the audit requirement have a real capability to call, or is it
   another Module02-org-coverage-style permanent gap?** Unlike that gap
   (confirmed by reading every .proto Module 02 exposes and finding
   nothing), core's `AuditService.RecordEvent` already exists, is already
   wired to a durable Postgres-backed queue with retry/DLQ (ADR-0042), and
   is explicitly documented as the platform's fire-and-forget audit
   ingestion point (`audit.proto`'s own header comment: "fire-and-forget
   from every service, batched into AuditLog"). This phase builds a real
   client against a real, working capability - not a stub, not a flagged
   gap.
3. **What does "capture the delta against already-processed payroll data"
   mean when no payroll system exists?** §5.1's literal wording assumes a
   Module 12 to diff against. Since none exists, the buildable
   interpretation is: capture the delta this decision itself creates in
   this module's own state, and surface an explicit
   `payrollResyncRequired` boolean as the flag §5.1 asks for - data a
   future Module 12 integration can key off, not a fabricated integration
   call to a system that doesn't exist.

## Decision

**`SubmitBackdatedLeaveDto`**: `employeeId`, `leaveTypeId`,
`dateRangeStart`, `dateRangeEnd`, `backdatedReason` (mandatory,
`@IsNotEmpty`). `LeaveRequestService.submitBackdatedLeave` validates
`dateRangeEnd >= dateRangeStart`, then that `dateRangeStart` actually is in
the past (`NotActuallyBackdatedError` otherwise, directing to
`requestLeave`) - the mirror image of `requestLeave`'s own
`BackdatedLeaveNotSupportedError` check, so the two mutations' valid input
ranges never overlap. Runs the same synchronous, fail-closed
`LeaveConflictCheckService.check` call as `requestLeave` (§5.1 is a
*stricter* audit path, not an exemption from ordinary conflict checking).

**`reserveAndSubmit` refactor**: the private method both `requestLeave` and
`submitBackdatedLeave` now call takes a new `options: { forcePending,
isBackdated, backdatedReason }` parameter instead of hardcoding `false`/
`null`. `forcePending: true` (set only by `submitBackdatedLeave`) makes the
pending/reservation branch unconditional, regardless of
`LeaveType.requiresApproval` - a backdated entry always needs a human
decision. This keeps the row-locking/balance-reservation logic - the
genuinely concurrency-critical part - in one place rather than duplicated
across two methods.

**Elevated permission**: `backdated_leave_entry` added to Module 01's
`RESOURCES` catalog (root `src/database/seeds/run-seed.ts`), generating
`backdated_leave_entry:{read,write,approve,delete}` permissions the same
way every other resource does. `DecideLeaveRequestService.applyDecision`
checks `request.isBackdated && dto.decision === APPROVED &&
!dto.actorPermissions?.includes('backdated_leave_entry:approve')` right
after locking the `LeaveRequest` row (so `isBackdated` is known) and before
locking `LeaveBalance` - `InsufficientPermissionError` (403) if missing.
Rejecting a backdated request needs no elevated permission. On approval,
`backdatedApprovedBy` is set to `dto.decidedBy` - the same actor, since
this phase has no separate co-signer concept.

**Audit trail**: `AuditGrpcClientService`/`AuditGrpcClientModule`
(`src/grpc/`) - a `@nestjs/microservices` `ClientGrpc` wrapper around
core's `AuditService.RecordEvent`, loading core's checked-in `audit.proto`
via a `process.cwd()`-relative path (stable across dev/build modes,
documented in the module's own comment - see ADR-0079 for why a
`__dirname`-relative path would not be). `DecideLeaveRequestService.decide`
calls `auditBackdatedDecision` after commit, for every decided backdated
request (approve or reject) - best-effort, same after-commit posture as
the existing NATS publish, and correct per `audit.proto`'s own documented
fire-and-forget contract. Payload: `action` is
`approve_backdated_leave_request`/`reject_backdated_leave_request`,
`beforeStateJson`/`afterStateJson` capture the pending -> decided delta,
`afterStateJson.payrollResyncRequired` is `true` only on approval.

## Blast radius

- New files: `src/common/errors/not-actually-backdated.error.ts`,
  `insufficient-permission.error.ts`; `src/leave/dto/submit-backdated-leave.dto.ts`;
  `src/grpc/audit-grpc-client.{module,service,constants}.ts`. Additive
  edits: `DecideLeaveRequestDto` (new optional `actorPermissions`),
  `LeaveRequestController` (new route, base path changed from
  `v1/leave/requests` to `v1/leave` with `@Post('requests')` - the final
  route is unchanged), `LeaveRequestService` (`reserveAndSubmit` gains an
  `options` parameter, new `submitBackdatedLeave` method),
  `DecideLeaveRequestService` (new `auditClient` constructor dependency,
  permission check + `backdatedApprovedBy` write + audit call),
  `MetricsService` (three new counters), `domain-error.filter.ts` (two new
  mappings), `.env.example` (`CORE_GRPC_URL`), `leave.module.ts` (imports
  `AuditGrpcClientModule`).
- Root `src/database/seeds/run-seed.ts`: `backdated_leave_entry` added to
  `RESOURCES`. No migration - this is seed data, not schema.
- No changes to any other module's service code. `attendance-leave-service`
  gains a new runtime dependency on core's gRPC surface for the decision
  path of backdated requests specifically - `requestLeave`/an ordinary
  `decideLeaveRequest` call never invoke it.

## Rollback plan

Revert `LeaveModule`'s `AuditGrpcClientModule` import, delete
`src/grpc/audit-grpc-client.*`, revert `DecideLeaveRequestService`'s
`auditClient` constructor param and the permission-check/audit-call
blocks, revert `LeaveRequestService`'s `submitBackdatedLeave` method and
`reserveAndSubmit`'s `options` parameter (restoring the two hardcoded
`isBackdated: false, backdatedReason: null` call sites), revert
`LeaveRequestController`'s new route, delete the two new error classes and
their filter mappings, revert `run-seed.ts`'s `RESOURCES` array. No
migration to revert - Phase 1 already shaped every column this phase
writes to.

Verified against real infrastructure, not just unit tests: a real local
Postgres (with both root's and this service's migrations + the RBAC seed
applied), real local Redis, real local NATS, a real built core service
(`node dist/src/main.js`, gRPC `AuditService` on its own port) and a real
built `attendance-leave-service`, a lightweight stub standing in for
scheduling-service's one conflict-check endpoint (this phase's own logic
is orthogonal to the conflict-check pipeline already verified in Phase 3).
See the production readiness checklist for the exact scenarios run,
including a genuine bug this verification caught (a circular import
between the new gRPC client's module and service files) that no unit test
could have.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`actorPermissions` is a client-supplied, unverified field** - the
   same trust posture `decidedBy`/`employeeId` already have throughout
   this module. This is not a real authorization boundary; it is the
   consistent extension of a gap this module has had since Phase 3/4, not
   a new one introduced here. Closing it platform-wide (real JWT
   verification flowing into every service) is out of scope for this
   phase and this module.
2. **The same actor is both `decidedBy` and `backdatedApprovedBy`.** §5.1
   describes an elevated *permission* requirement, not a distinct
   co-signer role - there is one decision, made by one actor who must hold
   the elevated permission to make it (for approval).
3. **`payrollResyncRequired` is recorded as audit-event data, not acted
   on.** No Module 12 exists to call. A future phase adding real payroll
   integration should treat this flag as its trigger condition.
4. **Rejecting a backdated request requires no elevated permission.** Only
   approval commits `used_days` and carries the payroll/compliance
   implication §5.1 describes; rejection releases the reservation and
   changes nothing a payroll system would need to know about.

## Out of scope for this phase (do not build yet)

- Real Module 12 (payroll) integration - see explicit assumption 3.
- GraphQL.
- `no_show` absence-pattern detection, carryover/expiry rule engine
  (Phase 7), `AbsencePattern` detection (Phase 8) - unaffected by this
  phase.
- Real JWT/session verification for `actorPermissions` or any other
  actor-identifying field in this module - see explicit assumption 1.
