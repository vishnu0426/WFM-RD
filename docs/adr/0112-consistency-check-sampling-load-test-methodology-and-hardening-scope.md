# ADR-0112: consistency-check job is a bounded sample, load test methodology, and Phase 8 hardening scope

## Context

§2.3 rule 4/§7's own closing line: "load testing, observability/hardening,
and the consistency-check job comparing materialized view aggregates
against fresh source reads." Three real decisions, each about scope
discipline as much as delivery - the same posture every sibling module's
own final phase (ADR-0092, ADR-0107) already took.

1. **The consistency-check job cannot afford to be exhaustive.**
   Re-deriving every row of every `mv_*` view from source on every tick
   would mean running each refresh job's own full aggregate query a
   second time for no reason beyond this check - the refresh job already
   does that daily. `MetricsService.consistencyCheckDiscrepanciesTotal`'s
   own doc comment (declared Phase 1) already settled this: the help
   text says "a materialized view *sample* disagreed," not "every row."
2. **No load-testing tool exists anywhere in this repository** (confirmed
   by grep for k6/artillery/autocannon/wrk/ab across every file type and
   every `package.json`'s devDependencies - none, anywhere). Three prior
   modules (04, 05, 07) each independently built the same hand-rolled,
   no-new-dependency standalone script pattern; a fourth reinventing a
   different approach would be inconsistent with an established
   precedent, not an improvement on it.
3. **This module never had an explicit §0.5 numeric read-latency SLO**
   the way Module 05/07 did (a literal "p99 < Nms" line). The closest
   thing this module's own code commits to is
   `MetricValidationService`'s cost-tier banding
   (`CHEAP_THRESHOLD_MS = 100`, `MODERATE_THRESHOLD_MS = 1000`) - a
   threshold for classifying a metric definition's own dry-run cost, not
   originally written as a load-test target.

## Decision

**Consistency-check job** (`MvConsistencyCheckJobService`, `RefreshModule`,
`0 4 * * *`, after every refresh job's own nightly tick): for each of the
4 `mv_*` views, samples `SAMPLE_SIZE = 20` already-upserted rows via the
primary pool (`MIGRATOR_PG_POOL`, same RLS-owner-bypass reasoning as every
refresh job, ADR-0098's precedent), then re-derives *only that exact
sampled group's* aggregate from source via the replica pool
(`MIGRATOR_REPLICA_PG_POOL`) - the identical per-view `SOURCE_QUERY` logic
each refresh job already runs, narrowed to one group's own keys instead of
every tenant at once. A disagreement beyond
`max(ABSOLUTE_TOLERANCE = 0.5, RELATIVE_TOLERANCE = 0.05 * freshValue)`
increments `consistencyCheckDiscrepanciesTotal{view_name}` and logs both
values - the metric's own doc comment framing ("an alerting condition, not
a silent discrepancy") is honored by *reporting* every real disagreement
found, not by trying to auto-repair one (repair already happens naturally
via the next refresh tick's own idempotent upsert).

A real discrepancy is not automatically a bug, and this ADR says so
explicitly rather than letting the job's own existence imply otherwise:
`data_as_of` already documents that an `mv_*` row lags source data by
however long since its last refresh, so a fresh recompute run between
ticks can legitimately disagree with a not-yet-refreshed row. Live
verification against this build's own real local Postgres + real
streaming replica (not mocked) found this in practice - three of four
views showed a real disagreement on first run, traced to source rows from
an earlier phase's own verification session that no longer exist on the
replica (the source data itself changed after the `mv_*` row was
computed, exactly the class of drift this job exists to surface) - and,
separately, a real bug in the *verification harness itself* (a
hand-rolled `pg.Pool` missing the `options: '-c TimeZone=UTC'` session
setting every refresh job's own replica pool provider sets, causing
`date_trunc('month', ...)` to truncate in the wrong session timezone and
produce false positives) - caught and fixed before trusting the result,
not shipped. After both fixes, a clean run against the same real infra
showed zero discrepancies; a manually-injected bad value was correctly
detected and reported, then reverted.

**Load test methodology**: a hand-rolled `scripts/load-test.ts`, no new
npm dependency - plain `fetch`, matching the exact precedent of
`scheduling-service/scripts/load_test_decomposition.py` (Module 04),
`intraday-service/scripts/load-test.ts` (Module 05, ADR-0071), and
`shift-marketplace-service/scripts/load-test.ts` (Module 07, ADR-0092).
Targets this module's own read path (`metricQuery`/`executiveSummary`,
mixed across the 6 Phase-4 platform-default metrics, 500 total concurrent
requests across 10 rounds) and Phase 6's async export job (10 concurrent
`POST /v1/analytics/exports`, polled to completion) against a real
booted service, real local Postgres primary + a real streaming physical
replica, and - stood up specifically for this run - a real local MinIO
instance (Phase 6's own verification proved export correctness one
request at a time; this is the first time it's been exercised under
concurrent load). Same dual-measurement posture as ADR-0071/0092:
reports both the client-observed round-trip time and the real
server-side `http_request_duration_seconds` histogram scraped from
`/metrics`, since the two diverge (client p99 121ms vs. server-side: all
500 calls landed in the same ≤25ms bucket) for the same reason ADR-0092
found for Module 07 - real client-side HTTP/event-loop overhead the
server-side metric correctly excludes, not a measurement error.
`CHEAP_THRESHOLD_MS`/`MODERATE_THRESHOLD_MS` are used as the honest
stand-in target for this run, explicitly disclosed as not a number this
build was ever given as a literal §0.5 target (`docs/module-09-phase-8-load-test-results.md`'s
own Configuration section says so).

**Hardening scope**: matched to what every sibling module's own final
phase actually did, not an unbounded catch-all.
- **No Prometheus alerting rules** - confirmed platform-wide absence
  (no sibling module's own final phase added one either).
- **No error-shape fixes needed** - checked (grep for
  `throw new HttpException`/`throw new Error` outside test files across
  this module's own `src/`) and found exactly one raw `throw new Error`
  (`export-storage.service.ts`'s `parseS3Uri` parse-assertion on this
  service's *own* internally-generated `fileUri` values, never a
  caller-reachable input) - not analogous to Module 08's own
  gRPC-client-unavailable gap (a real, externally-reachable failure mode
  that surfaced as a generic 500), so left as-is rather than manufacturing
  a fix for an unreachable invariant.
- **`docs/module-09-runbook.md`** + **`observability/grafana-dashboard-module-09.json`**
  (wired into `docker-compose.yml`'s `grafana` service) - built for the
  first time this phase, matching every sibling module's own exact
  structure/schema, since Module 09 had neither before Phase 8.

## Consequences

- The consistency-check job is real, scheduled, and proven against real
  infra to both pass clean and correctly detect an injected discrepancy -
  not merely unit-tested in isolation (11 new unit tests, all passing,
  147 total up from 136 in Phase 7).
- The load test is a real, repeatable release-gate artifact
  (`ts-node -r tsconfig-paths/register scripts/load-test.ts [concurrency] [rounds]`) -
  re-running it after a future change to the read/export path regenerates
  `docs/module-09-phase-8-load-test-results.md` in place, the same
  "living artifact, not a one-time snapshot" posture Module 05/07's own
  load tests take.
- This run's own real data volume (a few dozen rows per view, this
  build's own prior-phase verification fixtures) proves the read/export
  path's latency *floor* under real concurrency, not behavior at
  `EXPORT_MAX_ROWS`/`MAX_LIMIT`'s own numeric ceiling - both remain
  disclosed placeholders, unchanged by this phase, named again in the
  runbook and checklist rather than silently assumed validated.
- This module's local dev read replica was independently found, during
  this phase's own verification, to have drifted to a real ~32-minute
  lag after sitting idle since an earlier phase - a real environment
  quirk, not a code defect, disclosed in the runbook (§2) rather than
  silently worked around.
