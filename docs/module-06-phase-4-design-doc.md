# Module 06 Phase 4 Design Doc — Attendance & Leave Management: Approval Workflow

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1–3. This
phase's one genuinely new-infrastructure decision - introducing BullMQ/Redis
at all - was confirmed with the user ahead of Phase 1 rather than decided
unilaterally; ADR-0077 records the reasoning now that there's a concrete
job to point it at.
**Scope:** `decideLeaveRequest` (`POST /v1/leave/requests/:id/decision`):
row-locked approve/reject transition, `pending_days` → `used_days` on
approval, `pending_days` release on rejection (§2.2 rule 1's necessary
completion, not explicitly named by §3.3 but required by the model). The
BullMQ-backed `leave-approval-reminders` queue (ADR-0077): enqueued by
`LeaveRequestService.requestLeave` when the leave type requires approval,
cancelled by `decideLeaveRequest` on a timely decision, processed by an
in-process worker that logs/emits a metric if a request is still pending
past the reminder threshold. Also closes a real branch Phase 3 left
unhandled: `LeaveType.requiresApproval = false` now auto-approves a
request straight to `used_days` at submission time, no chain, no reminder.
**Does not build**: any real notification channel behind a fired reminder
(no Module 01 `NotificationPreference` integration exists anywhere in this
codebase); the Module04 gRPC/REST surface or NATS publish (Phase 5);
`submitBackdatedLeave` (Phase 6); GraphQL.

## Problem

Three things needed settling before writing the decision path:

1. **BullMQ vs. this platform's Postgres-cron-drain idiom.** Already
   flagged as an open question in Phase 1's own design doc and confirmed
   with the user then: BullMQ, as specified. ADR-0077 records why this
   specific job (per-row delay, cheap cancellation) is a legitimate fit
   for BullMQ even though the platform's other three durable-queue needs
   all use the cron-drain idiom instead, and why that isn't a reason to
   retrofit those three.
2. **`pending_days` release on rejection isn't in §3.3's literal text.**
   §3.3 only says "on approval, `pending_days` moves to `used_days`." A
   rejected request's reserved days going unmentioned is not the same as
   "leave them reserved forever" - that would silently and permanently
   shrink `availableDays` for every rejected request, a correctness bug
   this module's own compliance framing (§0) would not tolerate. Built as
   the obvious, necessary completion of §2.2 rule 1's model, not a
   guess.
3. **`LeaveType.requiresApproval = false` was schema from Phase 1 but
   never branched on.** Phase 3 unconditionally created every submission
   as `pending`. This phase is the first to actually read
   `requiresApproval` and route accordingly - explicitly *not* the
   "auto-approval... feature-flagged, opt-in, never default" capability
   §0.5 warns about, which is about a tenant-wide override bypassing
   configuration entirely. Honoring a per-leave-type flag that was always
   part of the schema is the schema working as designed. See explicit
   assumption 1.

## Decision

**`DecideLeaveRequestService.decide`**: `SELECT ... FOR UPDATE` on the
`LeaveRequest` row (so two concurrent decisions on the same request can't
both apply - the request-side equivalent of ADR-0074's balance lock), then
on its `LeaveBalance` row (identical composite-PK lock Phase 3's
submission uses), one transaction. `status !== pending` →
`LeaveRequestAlreadyDecidedError` (`409`) - decisions are not idempotent
the way `requestLeave`'s ledger-based dedup is (no client-supplied
idempotency key for a decision). On `approved`: `pending_days` decremented
by the request's day count, `used_days` incremented by the same amount.
On `rejected`: `pending_days` decremented only - released, not consumed.
Both paths update `LeaveRequest.status`/`decided_at`/`decided_by` in the
same transaction. `inclusiveDayCount` (Phase 3's helper) is exported and
reused here rather than re-derived, so the decision always reasons about
the exact same day count the submission reserved.

**`LeaveRequestService.reserveAndSubmit` (extended)**: after the existing
balance lock/check, fetches the `LeaveType` row (read-only, no lock
needed - nothing in this module mutates it) to branch:
- `requiresApproval: true` (unchanged from Phase 3's shape, plus): a fresh
  `approvalChainId` is generated and stored on the `LeaveRequest`,
  `pending_days` is reserved as before, status stays `pending`.
- `requiresApproval: false` (new): `used_days` is incremented directly
  (never touching `pending_days` at all), `LeaveRequest` is inserted as
  `approved` with `decidedAt: requestedAt`, `decidedBy: null` (a
  data-driven decision, not a human one), `approvalChainId: null`.

After the transaction commits, `requestLeave` enqueues a
`leave-approval-reminders` job (`LeaveApprovalQueueService.scheduleReminder`,
`jobId: leaveRequestId`) only in the `requiresApproval: true` case, with a
delay of `LEAVE_APPROVAL_REMINDER_DELAY_MS`. This call is outside the
transaction and best-effort (ADR-0077) - the same principle ADR-0074
states for the conflict-check call, extended to Redis: never hold a
Postgres transaction (or, here, anything) open across external I/O whose
failure shouldn't roll back an already-correct database state.

**`LeaveApprovalReminderWorker`**: on firing, re-reads
`LeaveRequest.status` for that id/tenant (via `withTenantConnection`,
since RLS applies here too) before doing anything. Still `pending` →
increments `leave_approval_reminders_fired_total` and logs a warning; any
other status (already decided, or a benign race with a cancel that hadn't
landed yet) → silent no-op. No fabricated "notification sent" claim - see
explicit assumption 2.

## Blast radius

- New files under `attendance-leave-service/src/leave/` (decide service,
  controller, DTO) and `src/leave/bullmq/` (queue service, worker) and
  `src/common/errors/` (two new `DomainError` subclasses). No new
  migration - Phase 1/3's schema already has every column this phase
  writes to (`approval_chain_id`, `decided_at`, `decided_by`, `status`).
- `LeaveRequestService.reserveAndSubmit`'s signature/return shape changed
  (now returns whether approval was required, for the caller to decide on
  enqueueing) - an internal, non-breaking change; `requestLeave`'s public
  return type is unchanged.
- `package.json` gains `bullmq`/`ioredis`; `.env.example` gains
  `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`LEAVE_APPROVAL_REMINDER_DELAY_MS`.
  `LeaveModule` gains two providers and one controller. `MetricsService`
  gains two metrics. `DomainErrorFilter` gains two status mappings.
- No Module 01–05 file touched. No `docker-compose.yml` change - points at
  the already-provisioned shared `redis` container (ADR-0077).

## Rollback plan

Revert `LeaveModule`'s new providers/controller, delete
`src/leave/bullmq/`, `decide-leave-request.*`, the two new error files,
and `reserveAndSubmit`'s `requiresApproval` branch (reverting to Phase 3's
unconditional-pending behavior). Remove `bullmq`/`ioredis` from
`package.json`. No migration to revert. Nothing external calls
`POST /v1/leave/requests/:id/decision` yet outside manual verification, so
rollback is a non-event now.

Verified against real infrastructure, not just unit tests: a real local
Postgres (Phase 1–3's migrations applied) plus a real local Redis
(`redis-server`) exercised the full lifecycle over real HTTP/BullMQ - see
the Phase 4 production readiness checklist for the exact scenarios run.

**This is what caught a real, repo-wide bug**, not a hypothetical one:
`LeaveApprovalQueueService`'s first real-Redis test enqueued a reminder
with `LEAVE_APPROVAL_REMINDER_DELAY_MS=3000` set as an actual env var and
watched it fire almost immediately instead of after 3 seconds, and watched
a cancelled (already-approved) request's reminder fire anyway. Root cause:
`ConfigService.get<number>(key, default)` does not cast at runtime - the
`<number>` is a TypeScript-only type hint, and an env var is always a
string. `Number(env-string) + ...` arithmetic (what BullMQ's `delay` option
does internally) silently breaks when handed a string instead of erroring
- `"3000"` doesn't add to `Date.now()`, it concatenates. Every
`config.get<number>(...)` call site in this service turned out to be a
latent instance of the same bug, including Phase 2's grace-period
thresholds (`ATTENDANCE_LATE_GRACE_MINUTES`/`ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES`)
- those happened to keep working by accident, because `>`/`<` comparison
operators (unlike `+`) *do* coerce a string operand, so the bug was
invisible there until arithmetic (not comparison) touched the value.
Fixed by adding `src/common/config/get-number-config.ts`
(`getNumberConfig(config, key, default)`) and switching every call site to
it (both this phase's and Phase 2's) - see that file's own doc comment for
the full mechanism, and its regression test
(`test/unit/common/config/get-number-config.spec.ts`) for a test that
actually reproduces the string-vs-number distinction rather than
constructing `ConfigService` from an object literal holding a real number
(which is what let this ship past Phase 2's own unit tests undetected).

## Explicit assumptions (spec was ambiguous or silent here)

1. **`LeaveType.requiresApproval = false` auto-approves at submission,
   distinct from §0.5's "auto-approval... feature-flagged, opt-in, never
   default" warning.** That warning describes a blanket tenant-level
   override that would bypass configuration entirely, treated as a
   high-blast-radius capability requiring its own future feature flag. A
   per-leave-type `requiresApproval` flag is ordinary schema-driven
   behavior that has been part of `LeaveType` since Phase 1's migration -
   honoring it is not building the risky capability §0.5 warns against.
   No tenant-wide auto-approve-everything override exists or is planned by
   this phase.
2. **No real notification channel exists behind a fired reminder.** Module
   01's `NotificationPreference` has no gRPC/REST client anywhere in this
   codebase. `LeaveApprovalReminderWorker` logs and increments a metric -
   an honest, real, alertable signal, not a fabricated "notification
   sent." A future phase (not assigned one by the module prompt) would
   need to build that integration for this to become a real reminder
   email/Slack message/etc.
3. **`POST /v1/leave/requests/:id/decision` is a REST addition beyond
   §3.2's table**, same posture as `requestLeave`'s own REST path
   (Phase 3's assumption 1) - functional surface ahead of GraphQL, not a
   spec-mandated path.
4. **A decision requires no re-validation against Module 04/02 conflict
   data.** `conflict_flags` were populated once, synchronously, at
   submission time (§2.2 rule 2, Phase 3) and are shown to the decider as
   context - `decideLeaveRequest` does not re-run the conflict check. The
   module prompt doesn't ask for a second check at decision time, and
   re-running it would reintroduce exactly the kind of "deferred to
   approval time" staleness §2.2 rule 2 explicitly rules out for the
   *first* check, applied backwards.
5. **`decidedBy` is accepted as an explicit field in the request body**,
   same header-trust-placeholder posture as `requestLeave`'s `employeeId`
   (Phase 3's assumption 1) - no real actor-identity plumbing exists yet
   to derive "who is deciding" from an authenticated session.

## Out of scope for this phase (do not build yet)

- Any real notification integration - see explicit assumption 2.
- `LeaveService.GetUnavailability`/`CheckScheduleConflict`, the
  `agno.leave.request.approved.v1` NATS publish, and re-pointing
  `scheduling-service`'s interim `leaveRecords` posture (ADR-0059) at real
  data - Phase 5. **This is the module's real §0.5 SLO** (leave-approval →
  Module 04 visibility, p99 < 2s) - `decideLeaveRequest` exists now, but
  nothing downstream of it propagates anywhere outside this service's own
  Postgres yet.
- `submitBackdatedLeave`, the elevated backdated-leave permission - Phase 6.
- Multi-step/multi-approver chains (e.g. manager then skip-level for long
  requests). §3.3's "multi-step chains orchestrated via BullMQ" wording is
  not specific enough to build a concrete multi-level model from without
  guessing at organizational structure this module doesn't own (Module 02
  does) - this phase implements a single pending-decision step per
  request, with BullMQ orchestrating reminder/escalation timing around
  that one step, not multiple sequential approval levels. Flagged as a
  real gap, not silently narrowed.
- GraphQL (`decideLeaveRequest` mutation).
