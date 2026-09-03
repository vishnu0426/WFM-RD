# Module 05 Phase 7 Design Doc — Intraday/Real-Time Management: Redis Degradation Handling + Load Testing at Scale

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05)
**Scope:** §6.1 in full (a proactive Redis health signal, a real
Postgres degraded-fallback source for `QueueLiveState`, and the
chaos/game-day exercise §0.5 names for this module specifically) plus
the release-gate load test from §0.5/§7.

## Problem

Phase 4 already built §6.1's core - the `dataFreshness` contract on
every live-state response, and `AgentLiveStateQueryService`'s degraded
fallback to the most recent `AdherenceEvent`, proven end-to-end against
a real simulated Redis failure. §8 phase 7 asks for "§6.1 in full, plus
the release-gate load test" - reading the actual current code (not
assumptions) turned up four concrete pieces still missing:

1. **No proactive Redis health signal.** Redis health was only ever
   checked reactively - `/readyz` calls `IntradayRedisService.ping()`
   per-request, and live-state queries only discover an outage by trying
   a real call and catching `IntradayRedisUnavailableError`. Nothing
   populated `/metrics` with Redis's up/down state unless a request
   happened to touch Redis during the outage - you cannot page on a
   signal that doesn't exist (§0.5's on-call ask: "sustained Redis
   write-latency regression").
2. **No NATS consumer lag metric anywhere**, despite §7's cross-cutting
   ask naming it specifically for this module and `MetricsService`'s own
   doc comment admitting the gap since Phase 1.
3. **`QueueLiveState`'s degraded fallback was still all-nulls** - Phase
   4's own checklist explicitly flagged this as not done.
4. **No load test had ever run.** §0.5 requires "a load test simulating
   100k+ concurrent agents generating state changes at realistic
   frequency... with Redis write throughput, NATS consumer lag, and
   subscription fan-out latency recorded as artifacts," validating the
   three stated SLOs.

See ADR-0071 for the full reasoning behind all four decisions.

## Decision

Summary of what shipped:

- **`RedisHeartbeatService`** (`@Cron` every 15s): pings Redis, sets a
  new `intraday_redis_up` gauge, observes latency into the existing
  `redisOperationDuration` histogram, logs state transitions. Pure
  observability - never consulted by any query's actual correctness path
  (ADR-0071's core reasoning: a stale cached "up" flag gating a response
  would be exactly the looks-live-but-isn't gap §6.1 rules out).
- **`NatsConsumerLagMonitorService`** (`@Cron` every 30s): reads
  `jsm.consumers.info(stream, durableName)` for this service's six known
  durable consumers, sets a new `intraday_nats_consumer_lag` gauge
  (`num_pending`) per consumer - closing a gap flagged since Phase 1.
- **`intraday.queue_metrics_snapshot`** (new migration, unpartitioned,
  7-day retention): the queue-side equivalent of `AdherenceEvent`,
  written by a new, independent durable consumer
  (`QueueMetricsSnapshotConsumerService`) on the same `queue.metrics_updated`
  subject `QueueMetricsUpdatedConsumerService` already consumes (same
  "second independent consumer, one per concern" precedent
  `AdherenceCalculatorConsumerService` already set). `QueueLiveStateQueryService`'s
  degraded branch now queries the most recent snapshot first, falling
  through to the original all-nulls response only when none exists yet.
- **`scripts/load-test.ts`**: a hand-rolled, no-new-dependency load
  test against real local infra - HMAC-signed ingestion requests at the
  spec's literal 100k+ agent scale, concurrent REST snapshot requests,
  and NATS-direct-publish-to-subscription-push fan-out latency with real
  per-push correlation (`QueueLiveState.currentVolume` carries a
  send-side sequence number). Results in
  `docs/module-05-phase-7-load-test-results.md`.
- **Chaos/game-day** (manual, not code): performed for real - killed the
  local Redis process mid-verification, confirmed `queueLiveState`
  responses flip to real (but stale) snapshot data with
  `dataFreshness.status: 'degraded'` rather than a hard failure or
  all-nulls, confirmed `/readyz` flips to 503, confirmed the heartbeat's
  down-transition log and gauge; restarted Redis, confirmed the
  up-transition log, gauge, `/readyz`, and the query all recovered.
  Separately, killed the running `intraday-service` process, published a
  real `agent.state_changed` message while it was down, restarted the
  service, confirmed the durable JetStream consumer caught up and
  applied that message correctly - no drift, no silent loss.

## Blast radius

New `src/redis/redis-heartbeat.service.ts`,
`src/consumers/nats-consumer-lag-monitor.service.ts`, one new migration,
`src/live-state/entities/queue-metrics-snapshot.entity.ts` +
`queue-metrics-snapshot.consumer.ts` +
`queue-metrics-snapshot-retention-scheduler.service.ts`,
`scripts/load-test.ts`. `MetricsService` gains two new Gauges.
`QueueLiveStateQueryService`'s degraded branch changes (additive
fallback, existing all-nulls path still reachable).
`IntradayRedisModule`/`ConsumersModule`/`LiveStateModule` each gain new
providers/imports. One new devDependency (`@types/ws`, type
declarations only, for `scripts/load-test.ts`'s `graphql-ws` client - no
new runtime dependency). No change to any existing consumer's Redis-write
or alert/reallocation logic. No `docker-compose.yml` change.

## Rollback plan

Delete the five new files and `scripts/load-test.ts`, revert the
migration (`DROP TABLE intraday.queue_metrics_snapshot`), revert
`QueueLiveStateQueryService`'s degraded branch to its prior
all-nulls-only form, remove the two new `MetricsService` gauges and the
new module provider registrations, remove the `@types/ws` devDependency.
Nothing outside this phase depends on any of it.

## Explicit assumptions

1. The Redis heartbeat and NATS lag monitor are pure observability
   additions - never consulted by any query's actual correctness path.
2. `queue_metrics_snapshot` retention is a flat 7 days - this table
   backs degraded-mode display only, not analytics.
3. The ingestion SLO is measured as the webhook endpoint's own
   round-trip time, matching `MetricsService`'s own existing doc-comment
   interpretation.
4. The load test hand-rolls a TS script against real local infra (no new
   npm dependency beyond `@types/ws` for typechecking an already-used
   runtime package).
5. Actual measured throughput/latency on a single local dev machine is
   reported honestly in the results doc, including any shortfall against
   the spec's literal "100k+" target.
6. `NatsConsumerLagMonitorService`'s consumer list is a hardcoded array
   of six known durable names, not a generalized registry - a future
   consumer needs a one-line addition or it silently has no lag metric.

## Out of scope for this phase

- Publishing to `AGNO_INTRADAY_DLQ` on a poison/terminated message - a
  real, pre-existing gap, orthogonal to Redis degradation/load testing;
  not created by this phase, not fixed by it either.
- Horizontal-scaling-safe, multi-instance PubSub - still coupled to the
  same consumer-partitioning work ADR-0063/0068 already deferred.
- Multi-region (§6.2) - Phase 8.
- Any change to the Node→Go extraction ADR (ADR-0063) - not revisited
  here.

## Verification

- `npm run typecheck && npm run build && npm run lint && npm test` - all
  clean; new unit specs for `RedisHeartbeatService` (gauge/log
  transitions across a mocked ping success→failure→success sequence),
  `NatsConsumerLagMonitorService` (gauge set per consumer, skips an
  unbound consumer, no-op when NATS itself is unavailable),
  `QueueMetricsSnapshotConsumerService`,
  `QueueMetricsSnapshotRetentionSchedulerService` (including its
  re-entrancy guard), and `QueueLiveStateQueryService`'s new
  snapshot-fallback branches (snapshot found / not found /
  Redis-unavailable-and-no-snapshot).
- Migration run against real local Postgres; RLS, index, and grants
  (`agno_intraday_app`: `SELECT, INSERT` only, matching `adherence_event`'s
  own append-only convention) confirmed via `psql`.
- End-to-end against real Redis/NATS/Postgres, booted service:
  hand-published `queue.metrics_updated`, confirmed a snapshot row
  landed; confirmed `/metrics` exposes real `intraday_redis_up`/
  `intraday_nats_consumer_lag` values from live Cron ticks (not just unit
  tests). Ran both chaos/game-day exercises for real (Redis kill/restart,
  service/consumer kill-while-publishing/restart-and-catch-up) - see
  Decision section above for the exact confirmed behavior at each step.
- Ran `scripts/load-test.ts` against the booted service at the spec's
  literal 100,000-employee scale - see
  `docs/module-05-phase-7-load-test-results.md` for the real numbers
  against all three SLOs and the Redis/NATS artifacts captured from
  `/metrics`.
- One ADR (0071) covering the four load-bearing decisions this phase
  made without existing precedent to copy.
