# Module 09 Phase 8 (Final) Design Doc — Analytics & Reporting: Consistency-Check Job, Load Testing, Observability/Hardening

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09)
**Scope:** §7's own closing line: "load testing, observability/hardening, and the consistency-check job comparing materialized view aggregates against fresh source reads (§2.3 rule 4)." The last of the module's 8 phases - no further phases follow.

## Problem

Three real decisions, matched against precedent rather than invented from scratch - see ADR-0112 for the full reasoning:

1. **The consistency-check job cannot re-derive every row of every view on every tick** without duplicating each refresh job's own daily work for no reason. `consistencyCheckDiscrepanciesTotal`'s own doc comment (declared Phase 1) already says "sample," not "every row" - the job's own design has to honor that.
2. **No load-testing tool exists anywhere in this repository.** Three prior modules (04/05/07) each independently built the same hand-rolled, no-new-dependency standalone script; this phase follows that precedent rather than introducing a fourth approach.
3. **This module never had an explicit §0.5 numeric read-latency SLO.** `MetricValidationService`'s `CHEAP_THRESHOLD_MS`/`MODERATE_THRESHOLD_MS` are the closest real numbers this module's own code commits to - used as an honest stand-in, disclosed as such.

## Decision

**`MvConsistencyCheckJobService`** (`RefreshModule`, `@Cron('0 4 * * *')`, after every refresh job's own nightly tick): for each of the 4 `mv_*` views, samples `SAMPLE_SIZE = 20` already-upserted rows via `MIGRATOR_PG_POOL`, re-derives that exact sampled group's own aggregate from source via `MIGRATOR_REPLICA_PG_POOL` (the same per-view query logic each refresh job already runs, narrowed to one group), and increments `consistencyCheckDiscrepanciesTotal{view_name}` plus logs both values whenever the disagreement exceeds `max(0.5, 0.05 * freshValue)`. Shares the refresh jobs' own two pools rather than needing new ones - a sampling check, not a fifth refresh job.

**Load test** (`scripts/load-test.ts`): 500 concurrent `metricQuery`/`executiveSummary` reads (10 rounds × 50) across the 6 Phase-4 platform-default metrics, plus a 10-concurrent burst of `POST /v1/analytics/exports` polled to completion - against a real booted service, real Postgres primary + streaming replica, and a real local MinIO instance stood up specifically for this run. Results written to `docs/module-09-phase-8-load-test-results.md`.

**Hardening**: `docs/module-09-runbook.md` + `observability/grafana-dashboard-module-09.json` (wired into `docker-compose.yml`), built for the first time this phase. No Prometheus alerting rules (platform-wide precedent). Checked for cheap error-shape fixes (Module 08's own Phase 8 precedent) and found none needed - the one raw `throw new Error` in this module (`export-storage.service.ts`'s `parseS3Uri`) is a parse-assertion on this service's own internally-generated data, never a caller-reachable input, not analogous to a real external-dependency gap.

## Blast radius

- New: `MvConsistencyCheckJobService` (added to `RefreshModule`'s existing providers, no new pools), `scripts/load-test.ts`, `docs/module-09-runbook.md`, `observability/grafana-dashboard-module-09.json`, one `docker-compose.yml` line, ADR-0112.
- Zero schema/migration changes - this phase reads from existing tables only.
- Zero modification to any refresh job's own code, to `MetricQueryEngineService`, or to any prior phase's application logic.
- Zero modification to any Module 01–08 table, migration, schema, or running code.

## Verification

Real, running process for every claim below - `analytics-reporting-service` alone (`:8600`), against real local Postgres (primary + a real streaming physical replica) and, for the export path specifically, a real local MinIO instance stood up for this phase:

- 11 new unit tests for `MvConsistencyCheckJobService` (all four views' compare logic, tolerance banding, per-group query scoping, error containment, the `tick()` overlap guard) - 147 total (up from 136 in Phase 7), all passing. `npx tsc --noEmit`/`npm run build`/`npm run lint` clean.
- **Live verification against real infra, not just unit tests**: a standalone script instantiated `MvConsistencyCheckJobService` directly against the real primary and real replica pools and called `tick()`. First run surfaced two real findings before either was trusted: (1) three of four views disagreed - traced to source rows from an earlier phase's own verification session no longer present on the replica, a genuine drift case this job is designed to catch; (2) the verification harness's own ad-hoc `pg.Pool` was missing the `options: '-c TimeZone=UTC'` session setting every refresh job's own replica pool provider sets, causing `date_trunc('month', ...)` to truncate in the wrong session timezone and produce false positives - fixed in the harness, not the job. After both were resolved, a clean re-run against the same real infra showed zero discrepancies; a manually-injected bad value (`terminations_count` bumped from 1 to 99 directly in Postgres) was correctly detected, logged, and reverted.
- **Load test run for real**: 500/500 concurrent reads succeeded (zero failures); server-side `http_request_duration_seconds` histogram shows every call landed in the ≤25ms bucket, comfortably inside the disclosed `CHEAP_THRESHOLD_MS` (100ms) band despite client-observed overhead pushing the client-side p99 to 121.4ms. All 10 concurrent exports completed for real against real MinIO (zero failures), completion latency p99 = 59.0ms. Full numbers and artifacts in the results doc.
- `observability/grafana-dashboard-module-09.json` validated as well-formed JSON (`python3 -m json.tool`).
- Process and MinIO instance killed and ports confirmed free afterward; injected test data reverted; the ad-hoc verification script deleted (not left in the repo, matching Module 08's own precedent that a one-off verification script isn't a permanent operational tool).

## Explicit assumptions (spec was ambiguous or silent here)

1. **The consistency-check job is a bounded sample (`SAMPLE_SIZE = 20`/view/tick), not an exhaustive recompute** - the metric's own Phase-1 doc comment already committed to this framing.
2. **A detected discrepancy is not automatically a bug** - normal drift between refresh ticks is expected and tolerance-banded; this job surfaces disagreements for human triage, it does not and cannot distinguish drift from a real aggregation bug on its own.
3. **`CHEAP_THRESHOLD_MS`/`MODERATE_THRESHOLD_MS` are used as the load test's stand-in target**, not a number this build was ever explicitly given as a literal §0.5 SLO.
4. **"Hardening" does not mean closing every disclosed gap from Phases 1-7** - matched to what every sibling module's own final phase actually did (runbook + dashboard + a targeted error-shape check), not an unbounded catch-all.
5. **Real data volume for the load test is small** (a few dozen rows per view, this build's own prior-phase fixtures) - proves the read/export path's latency floor under real concurrency, not behavior at `EXPORT_MAX_ROWS`/`MAX_LIMIT`'s own numeric ceiling.

## Out of scope for this phase (do not build - and no further phase exists to do it in)

- Prometheus alerting rules of any kind.
- A real Module 10 implementation, or any change to `NlQueryBridgeClient`'s current unavailable-by-design posture.
- `createScheduledExport`, a retention/lifecycle job for exports, a reaper for a crashed export job.
- RBAC/permission checks anywhere in this module.
- Load-testing `EXPORT_MAX_ROWS`/`MAX_LIMIT` at anything near their own numeric ceiling - no synthetic bulk-data generator exists anywhere in this platform to produce that volume honestly.
