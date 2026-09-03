# Module 05 Phase 7 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases
(§0.5), matching Phase 1–6's own format and honesty bar.

## Delivered in this phase (application code)

- [x] `RedisHeartbeatService` (`@Cron` every 15s) - a proactive
      `intraday_redis_up` gauge and heartbeat-latency histogram sample,
      closing the "you cannot page on a signal that doesn't exist" gap -
      proven end-to-end: a real Redis kill produced a real down-transition
      log and gauge flip within one tick, a real restart produced a real
      recovery log and gauge flip.
- [x] `NatsConsumerLagMonitorService` (`@Cron` every 30s) -
      `intraday_nats_consumer_lag` per durable consumer, closing a gap
      `MetricsService`'s own doc comment had flagged since Phase 1 -
      proven end-to-end with real values under both idle and 100k-event
      burst conditions (see the load test results doc).
- [x] `intraday.queue_metrics_snapshot` (RLS, index, `SELECT/INSERT`-only
      grants matching `adherence_event`'s own append-only convention) -
      migrated against real local Postgres, schema/RLS/grants confirmed
      via `psql`.
- [x] `QueueMetricsSnapshotConsumerService` + `QueueLiveStateQueryService`'s
      new degraded-fallback branch - `QueueLiveState` now has a real
      Postgres degraded-fallback source for the first time (Phase 4's own
      checklist explicitly flagged this as not done) - proven end-to-end:
      a real Redis kill produced a real degraded response carrying the
      snapshot's actual last-known values, not all-nulls; a restart
      produced full recovery back to `dataFreshness.status: 'ok'`.
- [x] `QueueMetricsSnapshotRetentionSchedulerService` (daily, 7-day
      window) - keeps the snapshot table bounded.
- [x] Chaos/game-day, performed for real (not simulated, not skipped):
      Redis primary killed mid-verification and restarted - degradation
      path engaged correctly (banner-equivalent `dataFreshness: 'degraded'`
      shown, `/readyz` 503, heartbeat transition logged) and recovered
      correctly. `intraday-service` itself killed while a real
      `agent.state_changed` message was published, then restarted - the
      durable JetStream consumer caught up from the stream and applied
      that message correctly, no drift, no silent loss - directly proving
      §0.5's own chaos/game-day bullet for this module.
- [x] `scripts/load-test.ts` - a real, no-new-runtime-dependency load
      test run against real local Redis/NATS/Postgres and a real booted
      service at the spec's literal 100,000-employee scale. **All three
      stated SLOs met**: ingestion p99 40.8ms (<100ms target), REST
      snapshot p99 18.0ms (<200ms target), subscription fan-out p99
      282.9ms (<500ms target, with real per-push latency correlation, not
      an aggregate). Full numbers, artifacts, and an honest interpretation
      (including the real, expected consumer-lag-then-drain finding) in
      `docs/module-05-phase-7-load-test-results.md`.
- [x] Unit test suite (6 new spec files: `RedisHeartbeatService`'s
      transition logging, `NatsConsumerLagMonitorService`'s per-consumer
      gauge setting and unbound-consumer/NATS-down skip paths,
      `QueueMetricsSnapshotConsumerService`,
      `QueueMetricsSnapshotRetentionSchedulerService`'s re-entrancy guard,
      and `QueueLiveStateQueryService`'s new snapshot-fallback branches -
      plus additive coverage on `QueueMetricsUpdatedConsumerService`'s
      existing consumer chain) - all passing, no live infra required to
      run `npm test`.
- [x] One ADR (0071) covering the four load-bearing decisions this phase
      made without existing precedent to copy.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Sustained (not bursty) 100k+ concurrent load over a long
      window.** This run validated a 15-second burst - it does not prove
      the same SLOs hold across hours of continuous traffic, particularly
      the sequential consumers' own throughput ceiling under non-bursty
      input. Flagged explicitly in the load test results doc's own
      Interpretation section, not glossed over.
- [ ] **Horizontal-scaling-safe, multi-instance PubSub/consumer
      partitioning.** This service still runs as a single instance -
      ADR-0063/0068's own already-stated, still-deferred scope boundary,
      not newly created or newly closed by this phase.
- [ ] **The actual Node→Go extraction decision.** This load test proves
      the stated SLOs hold at 100k+ agent burst scale on Node today - it
      does not by itself prove or disprove that Node's event loop will
      eventually bottleneck under sustained load at a materially larger
      scale. ADR-0063 already wrote the extraction boundary down; this
      phase doesn't revisit whether to actually use it.
- [ ] **Publishing to `AGNO_INTRADAY_DLQ` on a poison/terminated
      message.** `DurableJetStreamConsumer.term()` still just drops an
      unparseable message rather than routing it to the DLQ stream
      provisioned since Phase 1 - a real, pre-existing gap, orthogonal to
      this phase's Redis-degradation/load-testing scope, not created or
      fixed here.
- [ ] **A generalized durable-consumer registry.**
      `NatsConsumerLagMonitorService`'s consumer list is a hardcoded array
      of six known names - a future durable consumer needs a one-line
      addition here or it silently has no lag metric.
- [ ] **Multi-region (§6.2).** Phase 8's scope entirely, not touched here.
- [ ] **Real tenant authentication, `graphql-ws` connection-level tenant
      verification.** Same class of gap this platform has flagged and
      left open since ADR-0068/0069/0070 - not re-litigated or worsened by
      this phase.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases - not re-litigated per phase.
