# ADR-0040: `AuditService.RecordEvent`'s batching, synchronous validation, and dead-letter design

## Context
§3.3 requires `AuditService.RecordEvent`: "fire-and-forget from every
service, batched into AuditLog. Define the batching/flush strategy and what
happens on a downstream write failure (must not silently drop audit events
- define a retry/dead-letter path)." Three requirements in tension:
"fire-and-forget" (the calling service - Scheduling, Forecasting - should
not block on a Postgres round trip), "batched" (don't do one transaction
per event under load), and §2.2 rule 3's "reject the write if ai_rationale
is null for an ai_agent actor" (a correctness requirement that has to hold
even though the actual write is deferred).

## Decision
`AuditEventBatcherService.enqueue` validates §2.2 rule 3 **synchronously**,
before anything is buffered, and throws immediately if it fails -
`AuditGrpcController.RecordEvent` returns `{accepted: false, errorCode:
"AI_RATIONALE_REQUIRED"}` to the calling service right away. This is the
one part of "fire-and-forget" that is *not* deferred: a caller must know
synchronously whether its audit event was rejected outright, not discover
it later via an unreported async failure. Everything else - the actual
`audit_log` INSERT - happens on this service's own 2-second `@Cron` flush
tick, grouped by tenant (so each tenant's batch runs inside one bound
`TenantContextService.run`, matching the RLS/tenant-guard shape every other
write in this repo uses).

A flush failure (Postgres unreachable, etc.) requeues the event with an
incremented retry counter; after `FLUSH_MAX_RETRIES` (3) failed attempts,
the event is published to `agno.core.dlq.v1` via the same `NatsClientService`
the outbox publisher uses (ADR-0039) - reusing the established dead-letter
mechanism rather than inventing a second one. If that NATS publish also
fails, the event is logged at ERROR level with its full payload as the
last-resort durability floor.

## Consequences
- §2.2 rule 3 is now enforced at **three** independent points for any event
  that reaches `audit_log` via this path: `AuditEventBatcherService.enqueue`
  (fast, synchronous rejection), `AuditLogRepository.record` (Phase 1, the
  same check + it also drives the outbox write), and the DB `CHECK`
  constraint (Phase 1). Deliberately redundant, the same defense-in-depth
  posture ADR-0027 already established for PKCE's `S256`-only rule.
- **There is no second persistent queue behind NATS.** If both `audit_log`
  writes and the DLQ publish are failing simultaneously (e.g. total
  platform outage), an event is only as durable as this process's own
  in-memory queue and its ERROR-level log line - it does not survive a
  process restart in that specific failure window. This is an honest
  limitation, not a hidden one: a fully durable pipeline would need the
  gRPC handler to itself write to a durable queue (Postgres or NATS
  JetStream directly) *before* returning `accepted: true`, which would
  cost exactly the synchronous-write latency "fire-and-forget" was meant to
  avoid. Flagged in the production readiness checklist as a real trade-off,
  not resolved in this phase.
- The in-memory queue is per-process, not shared across horizontally scaled
  replicas - a graceful shutdown should flush the queue before exiting, or
  accept the same bounded-loss-window described above. Graceful-shutdown
  draining is not implemented in this phase (no `OnModuleDestroy` hook on
  `AuditEventBatcherService`) - flagged in the readiness checklist.
