# ADR-0039: `core.outbox_events` is a separate table/module from Module 02's `org.outbox_events`, with its own `NatsClientService`

## Context
§4 requires `AuditEvent`/`PolicyChanged` published to NATS JetStream via the
transactional outbox pattern (ADR-0019 already built this pattern for
Module 02's `EmployeeChanged`/`SkillExpiring`). Two designs were available:
extend Module 02's existing `EventingModule`/`org.outbox_events` to also
carry Module 01's events, or build Module 01 its own.

## Decision
A new `core.outbox_events` table (Phase 5 migration) and a new
`CoreEventingModule` (`src/modules/core-eventing`), structurally identical
to Module 02's `EventingModule`/`OutboxEventsRepository`/`OutboxPublisherService`
but scoped to the `core` schema and `agno.core.*` subjects
(`agno.core.audit.created.v1`, `agno.core.policy.changed.v1`,
`agno.core.dlq.v1` - distinct from `agno.org.dlq.v1`). Each module owns its
own outbox, the same "each module owns its own schema" rule already
established for every other table in this repo (§2.1's bounded-context
framing, ADR-0021's gRPC-boundary rationale).

**`NatsClientService` is duplicated, not extracted to a shared `common/nats`
module**, even though the class has zero module-specific logic and is a
plausible candidate for promotion to shared infrastructure (the same
category as `common/redis`, `common/tenant`). Deliberately conservative:
extracting it would mean modifying Module 02's already-shipped, already-
tested `EventingModule` as a side effect of Module 01's Phase 5 work -
touching another module's tested code to satisfy this module's own new
requirement was judged higher-risk than ~50 lines of duplication. Flagged
as a reasonable future consolidation, not done here.

## Consequences
- Two independent NATS connections exist in one running process (one per
  `NatsClientService` instance) once both modules are active - negligible
  resource cost, but worth knowing if diagnosing NATS connection-count
  metrics in production (§0.5's FinOps/observability framing).
- `CoreOutboxPublisherService` and Module 02's `OutboxPublisherService` are
  two independent `@Cron('*/10 * * * * *')` tickers - both fire every 10
  seconds, on the same schedule, coincidentally, since both simply copied
  the same interval rather than being coordinated. Not a correctness
  concern (each drains only its own table), but worth noting if the two
  tickers' load ever needs to be staggered under real traffic.
- If a future increment does promote `NatsClientService` to `common/nats`,
  both `CoreEventingModule` and Module 02's `EventingModule` should switch
  to it together, in one deliberate, reviewed change - not by one module
  quietly diverging from the other's copy.
