# ADR-0077: The approval-chain queue is real BullMQ (Redis), a deliberate first-use exception to this platform's Postgres-cron-drain idiom

## Context
§1's tech-stack table mandates BullMQ (Redis) for the leave approval-chain
workflow, explicitly contrasted with using Redis as a system of record
("background job queue, not system of record"). Every other "durable
queue" need in this platform to date - `core.webhook_deliveries`
(ADR-0046), `core.pending_audit_events` (ADR-0042), `core.outbox_events`
(ADR-0039) - uses a different, established idiom instead: a Postgres
staging table plus an `@Cron` polling-drain job with retry/dead-letter
columns, zero external queue infrastructure. Module 06's own Phase 1
design doc flagged this exact tension as an open decision, confirmed with
the user rather than resolved unilaterally: introduce BullMQ as specified,
or match the platform's existing cron-drain convention instead.

The user chose BullMQ, as specified. This ADR records why that is a
reasonable choice for this specific job, not just "the spec said so" -
and, symmetrically, why it is *not* a precedent for retrofitting BullMQ
onto the platform's other three cron-drain use sites.

## Decision
`leave-approval-reminders` (`LeaveApprovalQueueService`,
`LeaveApprovalReminderWorker`) is a real BullMQ `Queue`/`Worker` pair
against Redis - this service's first Redis presence of any kind (Phase 1
through 3 deliberately had none). Two properties of this specific job are
what the cron-drain idiom doesn't give for free, and what justify BullMQ
here even though the other three durable-queue use sites don't need it:

1. **Native per-job delay.** A reminder must fire once, at a time that
   varies per `LeaveRequest` (`LEAVE_APPROVAL_REMINDER_DELAY_MS` after
   submission) - BullMQ's `delay` option expresses this directly. The
   cron-drain idiom's tick interval is uniform across all rows in its
   table; expressing "check this specific row, but not until time T" would
   mean either a much finer tick interval (wasteful, still not real
   per-item delay) or a `remind_at` column plus `WHERE remind_at <= now()`
   polling - a workable but strictly worse-fit reimplementation of what a
   delayed-job queue already does correctly.
2. **Deterministic job identity for cheap cancellation.** `jobId: leaveRequestId`
   makes "cancel this specific pending reminder" (`DecideLeaveRequestService`,
   on a timely decision) an O(1) lookup-and-remove. The cron-drain idiom's
   tables don't have an equivalent "mark this row's future work canceled"
   primitive beyond a status column the poller must still scan past.

This is **not** a case for real job-queue features the other three
use sites also secretly want - `webhook_deliveries`/`pending_audit_events`/
`outbox_events` are all "drain everything ready right now, retry on
failure," uniform-cadence, no per-row delay or cancellation semantics.
Nothing about this ADR argues those should move to BullMQ; they stay
exactly as they are.

## Consequences
- This service gains its first genuine external infrastructure dependency
  beyond Postgres: Redis, `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`
  (`.env.example`), and the `bullmq`/`ioredis` npm packages. `docker-compose.yml`
  already provisions a shared `redis` container for Module 01/02's session/
  refresh-token use (ADR unrelated to this one) - this service points at
  that same instance, no new container.
- Redis is never this service's system of record for anything -
  `LeaveRequest.status`/`LeaveBalance.pending_days`/`used_days` in Postgres
  remain fully authoritative at all times. Every BullMQ interaction in this
  service is deliberately best-effort and non-transactional with the
  Postgres write that triggers it (`LeaveApprovalQueueService`'s own doc
  comment): a failed enqueue means one fewer reminder, a failed cancel
  means one stale reminder that the worker's own `LeaveRequest.status`
  re-check turns into a no-op. Neither failure mode can produce a wrong
  decision or a lost `LeaveRequest`.
- The worker runs in-process (no separate deployable) - §0's "not
  compute-heavy or high-throughput" framing doesn't justify a dedicated
  worker process the way, say, Module 04's async solve workers needed one
  (ADR-0060).
- No real notification channel exists behind a fired reminder yet (Module
  01's `NotificationPreference` isn't integrated anywhere in this
  codebase) - this phase's honest scope is a structured log line and a
  Prometheus counter, not a claimed "notification sent." See the Phase 4
  design doc's explicit assumptions for what a real integration needs.
- This pattern (BullMQ for genuinely delay/cancellation-shaped work) is
  available as precedent for a future need *in this service* with the same
  shape - it is not a platform-wide "BullMQ is now the approved queue
  technology" declaration superseding the cron-drain idiom elsewhere.
