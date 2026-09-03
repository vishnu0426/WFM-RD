# ADR-0071: Redis heartbeat and NATS lag as observability-only, queue_metrics_snapshot as the queue-side AdherenceEvent, and the load test's measurement methodology

## Context
§8 phase 7 asks for "§6.1 in full, plus the release-gate load test from
§0.5/§7." Phase 4 already built §6.1's core (the `dataFreshness`
contract, `AgentLiveStateQueryService`'s `AdherenceEvent`-backed degraded
fallback, proven end-to-end). Reading the actual current code (not
assumptions) found four concrete pieces still missing, each needing a
decision with no existing precedent to copy:

1. Redis health was only ever checked reactively (`/readyz` per-request,
   live-state queries catching `IntradayRedisUnavailableError`) - nothing
   populated `/metrics` with Redis's state unless a request happened to
   touch Redis during an outage.
2. `MetricsService`'s own doc comment had flagged "NATS consumer lag per
   subject" as an open gap since Phase 1, never closed despite Phase 2
   shipping three consumers to lag.
3. `QueueLiveState`'s degraded fallback was still all-nulls - Phase 4's
   own checklist explicitly named this as not done.
4. No load test had ever run, and no load-testing tool exists anywhere in
   this repo.

## Decision

**Heartbeat/lag monitor are pure observability, never a correctness
gate.** `RedisHeartbeatService` (`@Cron` every 15s) and
`NatsConsumerLagMonitorService` (`@Cron` every 30s) only ever write to
`MetricsService`'s new `intraday_redis_up`/`intraday_nats_consumer_lag`
gauges and to logs. Neither is consulted by
`AgentLiveStateQueryService`/`QueueLiveStateQueryService` - both keep
their existing, Phase-4-proven reactive try/catch. A 15s-stale cached
"Redis is up" flag used to gate a response's correctness would be exactly
the looks-live-but-isn't failure mode §6.1's own opening line rules out;
these services exist purely to make health visible between requests, for
`/metrics` scraping and on-call paging, not to decide what a query
returns.

**`queue_metrics_snapshot` is the queue-side `AdherenceEvent`.** A new,
unpartitioned Postgres table (expected volume - one row per
`queue.metrics_updated` event, far fewer queues than employees - doesn't
warrant `AdherenceEvent`'s partitioning machinery), written by a second,
independent durable consumer on `queue.metrics_updated`
(`QueueMetricsSnapshotConsumerService`, mirroring
`AdherenceCalculatorConsumerService`'s own precedent of a second consumer
on `agent.state_changed`), pruned by a daily 7-day-retention scheduler
(this table backs degraded display only, not analytics - the rollup
tables already own that). `QueueLiveStateQueryService`'s degraded branch
now queries it first, falling through to the original all-nulls response
only when no snapshot exists yet.

**Load test methodology**: a hand-rolled `scripts/load-test.ts`, no new
npm dependency - bounded-concurrency `fetch` plus the `nats`/`graphql-ws`
packages this service's own phase-by-phase verification scripts have
already used throughout this session. Same "standalone script, real
local infra, not mocked" precedent as
`scheduling-service/scripts/load_test_decomposition.py` (Module 04 Phase
7). The ingestion SLO ("webhook receipt to Redis write") is measured as
the webhook endpoint's own HTTP round-trip time - matching
`MetricsService`'s own pre-existing doc-comment interpretation
(`intraday_ingestion_events_total`'s help text already ties the SLO to
this endpoint, not a more complex async "time until Redis actually
reflects it" measurement nobody had defined a methodology for). The
subscription fan-out SLO is measured with real per-push correlation
(`QueueLiveState.currentVolume` carries a send-side sequence number,
matched back to a send timestamp on receipt) rather than a coarser
aggregate average, since the one field already on the type can carry it
without widening the GraphQL selection set beyond what a real client
would request.

## Consequences
- Sustained Redis downtime between two heartbeat ticks (up to ~15s) is
  invisible to `/metrics` until the next tick - an accepted, bounded gap;
  closing it further (e.g. sub-second heartbeats) trades observability
  freshness for needless Redis load and isn't what any stated SLO asks
  for.
- `NatsConsumerLagMonitorService`'s consumer list
  (`DURABLE_CONSUMER_NAMES`) is a hardcoded array of six known names, not
  a generalized registry - a new durable consumer added in a future phase
  needs a one-line addition here or it silently has no lag metric. Same
  low-ceremony trade-off already accepted elsewhere in this service (e.g.
  `AlertEscalationSchedulerService`'s raw SQL).
- `queue_metrics_snapshot`'s 7-day retention means a queue with a
  multi-week Redis-and-Postgres-simultaneous outage has no degraded data
  left to serve past that window - falls through to the honest all-nulls
  response, not a fabricated older value.
- The load test's ingestion-SLO interpretation means it validates the
  synchronous webhook path (signature verify, idempotency lock, NATS
  publish, HTTP response) but not the downstream asynchronous
  `AgentLiveState` write latency specifically - a real, accepted scope
  boundary matching how this SLO has been described in this codebase
  since Phase 1, not a new gap this phase introduces.
