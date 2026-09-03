# ADR-0063: Module 05's NATS subjects are keyed per-employee for ordering, and are the frozen contract boundary for a future Node→Go extraction

## Context
§4.3 states a correctness requirement this platform's existing NATS usage
has never had to solve: "state changes for a given `employeeId` must be
applied to Redis in the order they were emitted - an out-of-order apply
would show wrong current state." Every existing subject in this platform
(`agno.core.audit.created.v1`, `agno.org.employee.>`, Module 03/04's
forecasting/scheduling subjects) is either genuinely order-independent per
consumer or has no per-entity ordering requirement stated at all. The
source spec's own architecture assumed Kafka, where a partition key gives
this for free (same key → same partition → strict order for one consumer).
§1 already overrides Kafka to NATS JetStream platform-wide (mirroring
Modules 02/03/04) - but JetStream has no equivalent free partition-key
ordering primitive, so this module's Phase 1 has to design the ordering
guarantee explicitly rather than assume it carries over.

Separately, §0.5 names this module as the platform's top candidate for
extraction from Node to Go if the event loop bottlenecks under 100k+-agent
load, and explicitly asks that "the NATS subject/consumer boundaries are
the actual interface contract that must stay stable through that
extraction... write this constraint down as an ADR now, so a future team
doesn't have to reverse-engineer why the topic boundaries are drawn the way
they are." Phase 1 is where these subjects are first defined, so it is the
right point to decide this, not a retrofit once a Go rewrite is already
underway.

## Decision
`agno.intraday.agent.state_changed.v1` is not published to directly -
`agentStateChangedSubject(employeeId)` (`intraday-service/src/nats/subjects.ts`)
appends the employee id as a subject suffix:
`agno.intraday.agent.state_changed.v1.{employeeId}`. `IngestionService`
publishes every event for a given employee to that employee's own subject.
A Phase 2 consumer binds a filtered consumer per employee-subject (or a
partitioned set of durable consumers keyed the same way) rather than one
shared consumer racing across employees - JetStream preserves publish order
*within* a subject, which per-employee subjects turns into "preserves order
per employee," the actual guarantee §4.3 asks for. `queue.metrics_updated`
and `reallocation.suggested` are not employee-keyed - nothing in §2/§4
states a per-queue or per-reallocation ordering requirement, so they stay
on their plain, unsuffixed subjects; inventing ordering machinery neither
entity needs would be exactly the kind of speculative complexity this
platform's own non-negotiables argue against.

All three subjects (plus a not-yet-used `agno.intraday.dlq.v1`, following
every other module's dead-letter naming) are provisioned into a single
`AGNO_INTRADAY_EVENTS` JetStream stream (`scripts/provision-nats-streams.ts`),
subject-wildcarded (`agno.intraday.agent.>`, `agno.intraday.queue.>`,
`agno.intraday.reallocation.>`) so the per-employee suffix doesn't require
a per-employee stream registration - JetStream streams are provisioned by
subject *pattern*, not by literal subject, so this scales to any number of
employees without touching stream config. Retention is `Limits`/`File`/
`DiscardPolicy.Old` at **24 hours** (`§0.5`'s FinOps ask to state an actual
number) - this stream is for Phase 2's consumer to catch back up after an
outage and short-window replay/debugging, not durable history;
`AdherenceEvent` (Postgres, Phase 3) is this module's actual compliance
record.

The frozen boundary this ADR commits to for the §0.5 Node→Go extraction
path: **the subject names, the per-employee suffix convention, and the
JSON payload shapes in `subjects.ts` (`AgentStateChangedPayload` etc.) are
the interface.** A future Go rewrite of the consumer side (Phase 2's Redis
state updater, the adherence calculator, the reallocation engine) can be
swapped in without this Node ingestion service changing at all, provided it
binds the same subjects and speaks the same JSON payload shape - and
conversely, the Node producer side could be rewritten in Go later without
any *consumer* changing, for the same reason. Nothing about NATS
connection pooling, consumer group internals, or in-process buffering is
part of that contract - only the wire-visible subject/payload shape is.

## Consequences
- Ordering is per-employee, not global. Two different employees' state
  changes may be applied to Redis in either relative order - this is
  correct and intentional; §4.3 only requires ordering *within* one
  employee's own sequence of changes.
- A employee with an unusually high state-change frequency does not create
  a "hot partition" problem the way a Kafka partition-key design might -
  JetStream doesn't pre-allocate fixed partitions per key, so this scales
  differently (and better, for this specific access pattern) than the
  source spec's Kafka-shaped assumption would have.
- 24h retention means Phase 2's consumer (and any future Go rewrite of it)
  must not fall behind by more than 24h without losing events it hasn't
  yet applied - NATS consumer lag exceeding a defined threshold is named as
  an on-call page condition in §0.5 for exactly this reason. This phase
  ships the stream and its retention window; the alerting on lag itself is
  Phase 7 scope (load testing / observability hardening).
- Any future change to the subject grammar or payload shape is a breaking
  change to the frozen Node→Go boundary this ADR establishes, not a routine
  refactor - it needs to be treated with the same seriousness as changing a
  public API contract between two independently deployable services,
  because that is exactly what it is once a Go extraction happens.
