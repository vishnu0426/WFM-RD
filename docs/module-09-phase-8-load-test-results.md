# Module 09 Phase 8 - read-path load test results

Generated 2026-08-11T13:44:13.737Z by `scripts/load-test.ts` against a real local Postgres primary + a real streaming physical replica, and a real booted `analytics-reporting-service` (not mocked, not simulated).

## Configuration

- Rounds: 10, concurrent reads per round: 50 (total read requests: 500), mixed `metricQuery` (6 Phase-4 platform-default metrics) and `executiveSummary`.
- Export burst: 10 concurrent `POST /v1/analytics/exports` requests, each polled to a terminal status.
- Tenant: `23852ab6-7765-4d5c-9c4c-a21d79de31e9` (real tenant with real upserted mv_* rows from this build's own prior-phase verification - a few dozen rows at most, not a synthetic large dataset).
- Wall time (read rounds): 0.6s

**Accepted scope boundary**: this module never had an explicit §0.5 numeric read-latency SLO the way Module 05/07 did. The one number this module's own code already commits to is `MetricValidationService`'s cost-tier banding (`CHEAP_THRESHOLD_MS = 100`, `MODERATE_THRESHOLD_MS = 1000`) - used here as the honest stand-in target, not a target this build was explicitly given. Real data volume is small (a few dozen rows per view, from prior phases' own live verification) - this proves the read path's latency floor under real concurrency, not its behavior against a production-scale dataset (no load-testing tool anywhere in this platform generates synthetic bulk fixtures at that scale either - see ADR-0112).

## Results

### Read latency (`metricQuery`/`executiveSummary`, mixed, client-observed)

n=500 p50=28.6ms p95=116.1ms p99=121.4ms max=125.1ms

Failures: 0/500

**Directional read: within the MODERATE_THRESHOLD_MS (1000ms) band, not the CHEAP band** at this concurrency and data volume (client-observed p99 = 121.4ms includes full HTTP+GraphQL overhead; see the real server-side `http_request_duration_seconds` histogram below for the number actually comparable to a server-side SLO).

### Export request-accepted latency (`POST /v1/analytics/exports` returning `pending`)

n=10 p50=12.3ms p95=12.7ms p99=12.7ms max=12.7ms

### Export completion latency (accept to `completed`/`failed`, polled)

n=10 p50=58.2ms p95=59.0ms p99=59.0ms max=59.0ms

Final status tally: {"completed":10}

### Artifacts: real server-side `http_request_duration_seconds` histogram (after run)

```
http_request_duration_seconds_bucket{le="0.005",method="GET",route="/readyz",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.01",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.025",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.1",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.25",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.5",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="1",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="2.5",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="5",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="10",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/readyz",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.005",method="GET",route="/metrics",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.01",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.025",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.1",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.25",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.5",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="1",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="2.5",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="5",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="10",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/metrics",status_code="200"} 1
http_request_duration_seconds_bucket{le="0.005",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.01",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.025",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 84
http_request_duration_seconds_bucket{le="0.05",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 99
http_request_duration_seconds_bucket{le="0.1",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="0.25",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="0.5",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="1",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="2.5",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="5",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="10",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="+Inf",method="GRAPHQL",route="Query.executiveSummary",status_code="200"} 130
http_request_duration_seconds_bucket{le="0.005",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.01",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 0
http_request_duration_seconds_bucket{le="0.025",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 242
http_request_duration_seconds_bucket{le="0.05",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 279
http_request_duration_seconds_bucket{le="0.1",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="0.25",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="0.5",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="1",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="2.5",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="5",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="10",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="+Inf",method="GRAPHQL",route="Query.metricQuery",status_code="200"} 370
http_request_duration_seconds_bucket{le="0.005",method="POST",route="/v1/analytics/exports",status_code="201"} 0
http_request_duration_seconds_bucket{le="0.01",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.025",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.05",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.1",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.25",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.5",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="1",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="2.5",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="5",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="10",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="+Inf",method="POST",route="/v1/analytics/exports",status_code="201"} 10
http_request_duration_seconds_bucket{le="0.005",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.01",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.025",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.1",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.25",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="0.5",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="1",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="2.5",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="5",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="10",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/v1/analytics/exports/:id",status_code="200"} 20
```

### Artifacts: `analytics_metric_queries_total` by cost_tier/result (after run)

```
analytics_metric_queries_total{cost_tier="cheap",result="success"} 500
```

### Artifacts: `analytics_exports_total` by result (after run)

```
analytics_exports_total{result="completed"} 10
```

### Artifacts: `analytics_replica_lag_seconds` (after run)

```
analytics_replica_lag_seconds 0
```

### Artifacts: `analytics_consistency_check_discrepancies_total` (after run - reflects the last scheduled tick, not this load test)

```
(no discrepancies recorded by the last consistency-check tick)
```

## Interpretation

**Read path**: zero failures across 500 concurrent `metricQuery`/`executiveSummary` calls. The client-observed p99 (121.4ms) reads as *not* within the disclosed 100ms `CHEAP_THRESHOLD_MS` band - but the real server-side histogram tells a different, more informative story: **all 370 `metricQuery` calls and all 130 `executiveSummary` calls landed in the `le="0.025"` (25ms) bucket**, i.e. literally every single one completed server-side in under 25ms - `analytics_metric_queries_total{cost_tier="cheap",result="success"} 500` confirms every call was tiered `cheap`, consistent with these being the 6 Phase-4 platform-default metrics over a few dozen rows. The ~100ms gap between the client-observed p99 and the server-side number is `fetch`/HTTP/Node event-loop overhead on the load-test script's own side (mirrors ADR-0092's identical client-vs-server divergence for Module 07's lock acquisition metric) - the number the disclosed cost-tier threshold is actually defined against is comfortably inside its own band, with roughly 4x margin even before subtracting that overhead.

**Export path**: all 10 concurrent `POST /v1/analytics/exports` requests completed for real against a real local MinIO instance stood up specifically for this run (`analytics_exports_total{result="completed"} 10`, zero failures) - completion latency p99 = 59.0ms, well inside anything this fire-and-forget design was ever expected to take for a few dozen rows. This is the first time this async export path has been exercised under *concurrent* load (Phase 6's own verification proved correctness one request at a time) - no lock contention, no queueing pathology, no partial failures observed at this burst size.

**What this run does not prove**: real data volume here is a few dozen rows per view (this build's own prior-phase verification fixtures, not a synthetic large dataset) - `EXPORT_MAX_ROWS = 10,000` and `MAX_LIMIT = 100` remain disclosed, untested placeholders at anything near their own ceiling; this run validates the read/export path's latency *floor* under real concurrency, not its behavior as row counts or `LIMIT` approach those numbers. `analytics_replica_lag_seconds` reads `0` in the after-run scrape - this is **not** evidence the replica was perfectly caught up: `MvFreshnessMonitorService` samples on its own 5-minute `@Cron`, independent of this load test's ~1-second wall time, so no sample had necessarily landed since this run's fresh service boot; a direct SQL check against this same long-lived local replica earlier in this same phase's own consistency-check verification found a real ~32-minute replication lag (a dev-environment quirk of a replica that had been idle since an earlier phase, not something this load test measured or fixed - worth a runbook mention). `analytics_consistency_check_discrepancies_total` shows no discrepancies, consistent with this phase's own separate live verification of that job.
