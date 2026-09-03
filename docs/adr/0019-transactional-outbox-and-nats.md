# ADR-0019: Transactional outbox for `EmployeeChanged`/`SkillExpiring`, NATS JetStream publish decoupled from the DB write

## Context
§4 requires `EmployeeChanged` (created/updated/transferred/terminated) and
`SkillExpiring` events, published to NATS JetStream (§1 explicitly overrides the
source spec's Kafka diagram), with named consumers (Scheduling, Forecasting,
Attendance, Analytics) and a dead-letter stream (`agno.org.dlq.v1`). The dangerous
naive implementation is "write the entity, then publish to NATS in the same request" -
if the publish fails (NATS down, network partition) after the DB commit, the event is
silently lost; if it fails before, a retry might double-write the entity. Neither
failure mode is acceptable for events other services build cached state from.

## Decision
**Transactional outbox.** `org.outbox_events` is written in the *same* database
transaction as the entity change it describes -
`EmployeesRepository.createWithOutboxEvent`/`updateWithOutboxEvent` wrap both the
`Employee` write and the outbox insert in one `withTenantTransaction` call, so
"the employee changed but no event was queued" (or the reverse) is not a reachable
state, independent of whether NATS is reachable at write time.

**A separate publisher drains the outbox on its own schedule.**
`OutboxPublisherService` ticks every 10 seconds, fetching unpublished rows and
attempting `NatsClientService.publish`; success marks `published_at`, failure
increments `attempts`/`last_error` for the next tick to retry. After
`MAX_ATTEMPTS_BEFORE_DLQ` (5) failed attempts, the event is instead published to
`agno.org.dlq.v1` (§4's named dead-letter stream) and marked handled - a
permanently-unpublishable event does not retry forever and block the queue behind it.

**`NatsClientService` connects lazily**, on first publish attempt, not at app boot.
The app (and every REST/GraphQL endpoint unrelated to eventing) must keep working
whether or not a NATS broker is reachable in a given environment - the same posture
this repo already takes toward Postgres reachability being a runtime, not
compile-time, concern.

**The publisher runs as a platform-admin session**, same escape hatch as
`core.tenants` (ADR-0007) and `SkillDecaySchedulerService`'s tenant enumeration
(ADR-0017) - it has no single tenant to scope to, since one poll batch spans events
from many tenants.

## Consequences
- Idempotency for consumers (§4: "keyed on `(employee_id, event_type, updated_at)`")
  is the *consumer's* responsibility - this repo's payloads carry all three fields
  (`EmployeeChangedPayload`), but nothing here can guarantee at-most-once delivery.
  The outbox pattern guarantees at-least-once (a publish that "succeeds" per NATS but
  whose `markPublished` call then fails would retry and double-publish) - consumers
  built against this module must dedupe, not assume exactly-once.
- No real NATS broker is available in the environment this module was built/tested
  in - `OutboxPublisherService`'s retry/DLQ logic is covered by a unit test with a
  mocked `NatsClientService`; the outbox *write* (the correctness-critical,
  transactional half) is covered by a real integration test against Postgres. Actual
  end-to-end delivery to a live JetStream instance is unverified in this environment
  and needs to be exercised wherever this ships next to a real broker.
- `SkillExpiring` events are **not** transactionally tied to a competing write the
  way `EmployeeChanged` is - they're derived facts computed by the nightly decay job,
  not a direct consequence of one entity's own transaction, so
  `OutboxEventsRepository.record` (its own standalone transaction) is used instead of
  the `*WithOutboxEvent` combined-transaction methods.
