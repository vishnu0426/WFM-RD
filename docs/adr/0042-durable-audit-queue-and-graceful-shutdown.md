# ADR-0042: `AuditEventBatcherService`'s queue moves from in-memory to a durable Postgres table, plus a graceful-shutdown drain

## Context
ADR-0040 built `AuditEventBatcherService` as a fire-and-forget batcher:
`enqueue` pushed onto a plain in-memory JS array, and a 2-second `@Cron`
tick flushed it to `audit_log`. That ADR's own consequences section
admitted the honest limit of that design: "there is no durable queue
behind NATS in this design" - a process restart (deploy, crash, OOM kill)
between an `enqueue` call and the next flush tick lost every buffered
event silently, with no trace anywhere. The Phase 5 production readiness
checklist listed this as an explicit, unresolved gap, alongside a second,
related gap: `AuditEventBatcherService` had no `OnModuleDestroy` hook, so
even a *graceful* shutdown (a routine deploy's SIGTERM) didn't attempt to
flush whatever was still buffered before the process exited.

## Decision
`core.pending_audit_events` (migration
`1700000009000-Module01Phase5DurableAuditQueue`) replaces the in-memory
array. It is structurally the same "durable staging table" idea as
`core.outbox_events` (ADR-0039), applied one step earlier in the pipeline:

- `enqueue` still validates §2.2 rule 3 synchronously (unchanged from
  ADR-0040 - a caller must get an immediate, correct rejection, not a
  later silent failure), then durably inserts a row via
  `PendingAuditEventsRepository.enqueue` before returning. The insert
  itself is awaited internally and any failure is logged at ERROR level
  with the full event payload - but the *caller* (`AuditGrpcController`,
  `OAuthController`, ...) does not await it, preserving §3.3's "fire and
  forget from the caller's perspective" contract. A single-row indexed
  insert into a narrow table is materially cheaper than the full
  `audit_log` + `core.outbox_events` transactional write `enqueue` was
  originally built to avoid, so this does not reintroduce the latency cost
  ADR-0040 was written to avoid.
- The 2-second flush tick now reads a batch from
  `core.pending_audit_events` (`PendingAuditEventsRepository.findBatch`,
  cross-tenant, same `SYSTEM_BATCH_CONTEXT_TENANT_ID` + platform-admin
  escape hatch as `CoreOutboxEventsRepository`) instead of draining a JS
  array. A successfully-written event's row is deleted
  (`PendingAuditEventsRepository.delete`); a failed one has its `attempts`/
  `last_error` columns updated in place
  (`PendingAuditEventsRepository.recordFailure`) rather than being
  requeued as an in-memory copy.
- Retry/DLQ semantics are otherwise unchanged from ADR-0040:
  `FLUSH_MAX_RETRIES = 3`, then routed to `agno.core.dlq.v1` and deleted.
  If the DLQ publish itself also fails, the row is deliberately *not*
  deleted - it stays in the durable queue and is retried again next tick,
  which is strictly better than the old design (where that same double-
  failure scenario had no recovery path at all beyond an ERROR log line).
- `AuditEventBatcherService` now implements `OnModuleDestroy`, calling
  `flush()` one more time. `main.ts` calls `app.enableShutdownHooks()` -
  without it, Nest never invokes `OnModuleDestroy` on SIGTERM/SIGINT at
  all, so this half of the fix is required for the hook to do anything.

## Consequences
- A process crash between `enqueue` and the next flush tick now loses
  nothing - the row is sitting in Postgres for the next tick (in this
  process, if it recovers, or a replacement process after a restart) to
  pick up. This is the specific gap this ADR closes.
- `core.pending_audit_events` needs `DELETE`/`UPDATE` grants for
  `agno_app`, unlike `audit_log`/`core.outbox_events` - it is a working
  queue, not a durable record of what happened, so deleting processed rows
  is correct and necessary to keep it bounded.
- Still not solved (deliberately, out of scope for this change): multiple
  horizontally-scaled replicas' flush ticks could both read the same
  unprocessed row in the same 2-second window (no `SELECT ... FOR UPDATE
  SKIP LOCKED`) - the same single-instance assumption `CoreOutboxEventsRepository`
  already carries (ADR-0019/ADR-0039), not a new gap introduced here.
- The graceful-shutdown drain is a "shorten the window under normal
  operation" improvement, not what actually provides durability - the
  durable queue is what prevents loss; the drain just means a routine
  deploy doesn't leave rows sitting for up to 2 seconds for no reason. A
  hard kill (SIGKILL, OOM) still skips `OnModuleDestroy` entirely, same as
  any Postgres-backed queue under any framework - the durable table is
  what makes that case still safe, not the shutdown hook.
