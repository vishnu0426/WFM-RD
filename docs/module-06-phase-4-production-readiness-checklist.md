# Module 06 Phase 4 Production Readiness Checklist

Same honesty bar as Phases 1–3. This phase introduces the module's first
external infrastructure dependency beyond Postgres (Redis, via BullMQ) -
the delivered list is verified against both real Postgres and real Redis,
not mocks, for exactly the reason ADR-0077 exists: a queue interaction
that only "passes" against a mock proves nothing about delay/cancellation
semantics actually working.

## Delivered in this phase (application code)

- [x] `POST /v1/leave/requests/:id/decision` (`DecideLeaveRequestController`
      / `DecideLeaveRequestService`): row-locked `LeaveRequest` +
      `LeaveBalance` transition, `pending_days` → `used_days` on approval,
      `pending_days` released (not consumed) on rejection, `409` on a
      request that's already been decided.
- [x] `LeaveType.requiresApproval = false` now auto-approves at submission
      (straight to `used_days`, no chain, no reminder) - a real branch
      Phase 3 left unhandled, closed this phase.
- [x] `leave-approval-reminders` BullMQ queue (ADR-0077): enqueued
      (`jobId: leaveRequestId`, delay = `LEAVE_APPROVAL_REMINDER_DELAY_MS`)
      only when `requiresApproval: true`; cancelled on a timely decision;
      the in-process worker re-checks `LeaveRequest.status` before acting,
      so a missed cancel degrades to a harmless no-op, never a stale/wrong
      signal.
- [x] Standard REST error envelope extended: `LEAVE_REQUEST_NOT_FOUND` (404),
      `LEAVE_REQUEST_ALREADY_DECIDED` (409), registered in
      `DomainErrorFilter`.
- [x] Metrics: `leave_request_decisions_total{result}`,
      `leave_approval_reminders_fired_total`.
- [x] Unit tests: `LeaveRequestService`'s new `requiresApproval` branching
      (both paths, including "no reminder scheduled" for the auto-approve
      case) against a mocked `DataSource`/`EntityManager`/queue;
      `DecideLeaveRequestService` (approve/reject balance transitions,
      already-decided rejection, not-found rejection, cancel-reminder
      call) against the same mocking shape; `LeaveApprovalQueueService`
      and `LeaveApprovalReminderWorker` against a mocked `bullmq` module.
      No live Postgres or Redis required to run `npm test`.
- [x] Verified against real local Postgres + real local Redis
      (`redis-server`), not just unit tests: the full lifecycle exercised
      over real HTTP against the built app - `requestLeave` with
      `requiresApproval: true` (job enqueued, confirmed present in Redis),
      `decideLeaveRequest` approving it before the reminder delay elapsed
      (job cancelled, confirmed absent), a second `requestLeave` with a
      short reminder delay left undecided (the worker actually fired,
      `leave_approval_reminders_fired_total` incremented, confirmed via
      `/metrics`), `requestLeave` against a `requiresApproval: false`
      `LeaveType` (immediately `approved`, `used_days` incremented,
      `pending_days` untouched, no job ever created), and
      `decideLeaveRequest` against an already-decided request (`409`).
      **This first real-Redis run caught a real bug, not a hypothetical
      one**: a 3-second configured delay fired in under 50ms, and a
      cancelled reminder fired anyway. Root cause: `ConfigService.get<number>()`
      doesn't cast at runtime (a real env var is a string;
      `<number>` is a TypeScript-only hint), and BullMQ's `delay` option
      does arithmetic on it internally - a string delay silently
      concatenates instead of adding. This affected every numeric config
      value in this service, including Phase 2's grace-period thresholds
      (masked there because comparison operators, unlike arithmetic, do
      coerce a string operand). Fixed with a `getNumberConfig` helper
      applied to all six call sites (three from Phase 2, three from this
      phase) plus a regression test that reproduces the string-env-var
      case Phase 2's own unit tests never exercised. Re-verified after the
      fix: the reminder fired exactly 3 seconds after submission, and
      cancellation correctly prevented the approved request's reminder
      from firing at all. See the design doc's Rollback plan section for
      the full writeup.

## Explicitly NOT done here (needs a later phase)

- [ ] **Any real notification channel.** `LeaveApprovalReminderWorker`
      logs and increments a metric - no email/Slack/push, no Module 01
      `NotificationPreference` integration exists anywhere in this
      codebase. See the design doc's explicit assumption 2.
- [ ] **`LeaveService.GetUnavailability`/`CheckScheduleConflict`, the
      `agno.leave.request.approved.v1` NATS publish.** No gRPC server or
      NATS client exists in this service yet - Phase 5. This is where
      §0.5's real SLO (leave-approval → Module 04 visibility, p99 < 2s)
      actually starts being measurable; it is not measurable yet, and
      `decideLeaveRequest` existing this phase should not be read as
      closing that SLO.
- [ ] **`submitBackdatedLeave`, the elevated backdated-leave permission.**
      Phase 6.
- [ ] **Multi-step/multi-approver approval chains.** This phase implements
      a single pending-decision step with BullMQ orchestrating
      reminder/escalation timing around it - not sequential
      manager-then-skip-level chains. See the design doc's out-of-scope
      section for why a concrete multi-level model wasn't built.
- [ ] **GraphQL (`decideLeaveRequest` mutation).** REST only this phase.
- [ ] **A separate BullMQ worker deployable, horizontal worker scaling,
      Redis Sentinel/Cluster HA.** The worker runs in-process; §0's
      framing doesn't justify more than that at this module's scale, but
      it also means this hasn't been load- or failover-tested.
- [ ] **Terraform for real Postgres/Redis provisioning, Vault for
      credential issuance, in-process/gateway rate limiting, penetration
      testing / SOC2 / ISO27001, SAST / dependency scanning / SBOM.** Same
      explicit non-goals already stated platform-wide for every phase.
