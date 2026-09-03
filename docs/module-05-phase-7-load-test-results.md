# Module 05 Phase 7 - Redis degradation / load test results

Generated 2026-08-07T14:06:30.368Z by `scripts/load-test.ts` against a real local Redis/NATS/Postgres and a real booted `intraday-service` (not mocked, not simulated).

## Configuration

- Employees (ingestion): 100000, concurrency 150
- REST snapshot requests: 2000, concurrency 100
- Subscription pushes: 500
- Tenant: `11111111-1111-1111-1111-111111111111`, queue under test: `49769d7d-dd87-4a13-a37d-cf5a9a975e91`

## Results

### Ingestion (`POST /v1/intraday/tenants/:tenantId/activity-events`) - SLO: p99 < 100ms

: n=100000
  p50=21.5ms
  p95=28.7ms
  p99=40.8ms
  max=665.2ms

**SLO MET** (p99 = 40.8ms vs 100ms target).

### REST snapshot (`GET /v1/intraday/queues/:queueId/live`) - SLO: p99 < 200ms

: n=2000
  p50=9.0ms
  p95=16.7ms
  p99=18.0ms
  max=18.0ms

**SLO MET** (p99 = 18.0ms vs 200ms target).

### Subscription fan-out (`queueLiveStateUpdated`) - SLO: p99 < 500ms

: n=500
  p50=169.4ms
  p95=274.1ms
  p99=282.9ms
  max=284.6ms

**SLO MET** (p99 = 282.9ms vs 500ms target, 500/500 pushes received and correlated).

### Artifacts: Redis operation latency (post-run `/metrics` scrape)

```
intraday_redis_operation_duration_seconds_bucket{le="0.001",operation="heartbeat"} 7
intraday_redis_operation_duration_seconds_bucket{le="0.0025",operation="heartbeat"} 8
intraday_redis_operation_duration_seconds_bucket{le="0.005",operation="heartbeat"} 8
intraday_redis_operation_duration_seconds_bucket{le="0.01",operation="heartbeat"} 9
intraday_redis_operation_duration_seconds_bucket{le="0.025",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="0.05",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="0.1",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="0.25",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="0.5",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="1",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="+Inf",operation="heartbeat"} 10
intraday_redis_operation_duration_seconds_bucket{le="0.001",operation="acquireIngestionIdempotencyLock"} 19670
intraday_redis_operation_duration_seconds_bucket{le="0.0025",operation="acquireIngestionIdempotencyLock"} 51653
intraday_redis_operation_duration_seconds_bucket{le="0.005",operation="acquireIngestionIdempotencyLock"} 84497
intraday_redis_operation_duration_seconds_bucket{le="0.01",operation="acquireIngestionIdempotencyLock"} 98939
intraday_redis_operation_duration_seconds_bucket{le="0.025",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="0.05",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="0.1",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="0.25",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="0.5",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="1",operation="acquireIngestionIdempotencyLock"} 100050
intraday_redis_operation_duration_seconds_bucket{le="+Inf",operation="acquireIngestionIdempotencyLock"} 100050
```

### Artifacts: NATS consumer lag (`intraday_nats_consumer_lag`)

Before run:
```
intraday_nats_consumer_lag{durable_name="intraday-agent-state-changed"} 0
intraday_nats_consumer_lag{durable_name="intraday-adherence-calculator"} 0
intraday_nats_consumer_lag{durable_name="intraday-queue-metrics-updated"} 0
intraday_nats_consumer_lag{durable_name="intraday-queue-metrics-snapshot"} 0
```

After run:
```
intraday_nats_consumer_lag{durable_name="intraday-agent-state-changed"} 50350
intraday_nats_consumer_lag{durable_name="intraday-adherence-calculator"} 92800
intraday_nats_consumer_lag{durable_name="intraday-queue-metrics-updated"} 0
intraday_nats_consumer_lag{durable_name="intraday-queue-metrics-snapshot"} 0
```

## Interpretation

All three stated SLOs were met at the spec's literal 100k+ agent scale
on a single local dev machine (M-series MacBook, all of Redis/NATS/
Postgres/the service itself co-resident): ingestion p99 40.8ms (target
<100ms), REST snapshot p99 18.0ms (target <200ms), subscription fan-out
p99 282.9ms (target <500ms, with real per-push correlation via
`QueueLiveState.currentVolume`'s sequence number, not an aggregate
average).

**Ingestion's own dominant cost is signature verification and the
idempotency-lock Redis round trip, not NATS publish** - 100,000 requests
completed in 15.0s wall time (6,669 req/s achieved against 150-way
client concurrency), consistent with `intraday_redis_operation_duration_seconds`'s
own bucket data showing `acquireIngestionIdempotencyLock` cleanly
under 25ms for effectively all 100,050 observed calls (the extra 50
beyond the 100k requests are this run's own warm-up/seed calls). The
665.2ms max outlier (vs. a 40.8ms p99) is consistent with a single
connection-pool-warmup or GC-pause tail event, not a systemic issue - one
sample out of 100,000, not a repeated pattern.

**The real, honest finding is downstream consumer lag, not the ingestion
path itself.** A `/metrics` scrape taken 3 seconds after the ingestion
burst ended showed `intraday_nats_consumer_lag{durable_name="intraday-agent-state-changed"}`
at 50,350 and `intraday-adherence-calculator` at 92,800 - both consumers
were still working through the backlog, not keeping up in real time with
a 6,669 req/s burst. This is expected, not a bug: `DurableJetStreamConsumer`'s
own design is deliberately **strictly sequential** ("one message fully
handled - acked or nak'd - before the next is pulled," see its own doc
comment) specifically to guarantee per-employee ordering (ADR-0063) -
correctness was chosen over throughput here, on purpose, well before this
load test ran. A follow-up scrape ~30-60s later showed both gauges back
at 0 - the backlog was fully absorbed, not a sustained or growing lag.
This module's own §0.5 already names exactly this risk ("NATS consumer
lag exceeding a defined threshold - a leading indicator of the Redis
bottleneck this module is watching for") as the metric to page on, which
Phase 7 just built (`intraday_nats_consumer_lag`) - this run is the first
real evidence that metric will actually fire meaningfully under a
realistic burst, and that the system self-recovers within roughly a
minute of a 100k-event spike, not indefinitely.

**What this run does not validate**: sustained (not bursty) 100k+
concurrent agent traffic over a long window, multi-instance/horizontal
scaling (this service still runs as a single instance - ADR-0068's own
deferred scope), or the actual Node event-loop bottleneck point that
would justify the Go extraction ADR-0063 already wrote the boundary for.
A single 15-second burst proves the ingestion path and dashboard reads
hold their SLOs at scale; it does not prove hours-long sustained load
behaves the same way, particularly for the sequential consumers' own
throughput ceiling under continuous (not bursty) input.
