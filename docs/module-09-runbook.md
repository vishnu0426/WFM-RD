# Module 09 Runbook — Analytics & Reporting

Operational reference for `analytics-reporting-service` (Phases 1-8). Every
check below is a direct SQL query against `analytics.*`/`analytics_mv.*`
(any role with `SELECT` - `agno_migrator` locally), a scrape of the one
`/metrics` endpoint (`GET :8600/metrics`), or a `curl`/GraphQL request
against the real REST/GraphQL surface - see
`observability/grafana-dashboard-module-09.json` for the panelled view of
the same data.

## 0. One process, three real external dependencies

`analytics-reporting-service` (`node dist/src/main.js`) is a single
process: the REST/GraphQL API and five `@Cron` jobs
(`MvAdherenceTrendRollupRefreshJobService`,
`MvForecastAccuracyTrendRefreshJobService`, `MvCostVsBudgetRefreshJobService`,
`MvAttritionBySiteRefreshJobService`, `MvFreshnessMonitorService`, and -
since Phase 8 - `MvConsistencyCheckJobService`) all run in-process. Three
real dependencies:

- **Postgres primary** (`analytics` schema, RLS via `withTenantConnection`
  on every request-path query, ADR-0002/0093 precedent) - `GET /readyz`
  checks this connection only. A second, separate `agno_migrator`
  connection pool (`MIGRATOR_PG_POOL`) backs the five cross-tenant
  `@Cron` jobs (ADR-0108/ADR-0098's RLS-owner-bypass precedent).
- **Postgres read replica** (`MIGRATOR_REPLICA_PG_POOL` for the refresh/
  consistency-check jobs' source reads, `ANALYTICS_APP_REPLICA_PG_POOL`
  for every live `metricQuery`/`executiveSummary`/BI-connector/export
  read - ADR-0108, §0.6's resolution of the platform-banned ClickHouse/
  Kafka architecture). Not checked by `/readyz` - a lagging or
  unreachable replica degrades *freshness* (`dataAsOf`), not this
  service's own liveness/readiness.
- **S3 (or an S3-compatible endpoint, e.g. local MinIO for dev/test)** -
  called by `ExportStorageService` for Phase 6's async export job only.
  No other feature in this module touches S3.

There is also a fourth, permanently-not-connected dependency by design:
**Module 10 does not exist** (ADR-0111) - `askAnalyticsQuestion` always
fails with `NL_QUERY_BRIDGE_UNAVAILABLE`. See §6.

## 1. Postgres primary is down or unreachable

**Confirm it's real**: `curl :8600/readyz` returns
`{"status":"degraded","postgres":"unreachable"}`. `/healthz` still returns
`ok` - the same liveness/readiness split every other service in this
platform uses, deliberately: an orchestrator must not kill an otherwise-
healthy process just because a dependency is down.

**What clients see**: every GraphQL/REST call that touches `SavedReport`/
`MetricDefinition`/`DashboardWidget` CRUD fails; the five `@Cron` jobs'
writes into `analytics_mv`/`mv_lineage` fail and are logged (`... refresh
failed: ...`), each independently, next tick retries automatically
(idempotent `ON CONFLICT ... DO UPDATE`, §2.2 rule 4).

**Recovery**: nothing to do manually - the next request/tick after
Postgres recovers succeeds normally.

## 2. The read replica is lagging or unreachable

**Confirm it's real**:
```
curl :8600/metrics | grep analytics_replica_lag_seconds
psql -h <replica-host> -p <replica-port> -U agno_migrator -d agno_wfm -c "SELECT pg_is_in_recovery(), now() - pg_last_xact_replay_timestamp();"
```
**A real, disclosed prom-client quirk**: `analytics_replica_lag_seconds`
is an *unlabeled* Gauge, initialized to `0` the moment the process
registers it, before the first real sample - a freshly-booted instance
reads `0` regardless of whether a replica is actually configured or
caught up (`MvFreshnessMonitorService`'s own doc comment, confirmed by
this service's own unit test, not assumed). Pair this reading with
`analytics_mv_refresh_job_runs_total`'s own activity before trusting a
`0` as "healthy." This build's own local dev replica was independently
found, during Phase 8's own verification, to have drifted to a real
~32-minute lag after sitting idle since an earlier phase's verification
session - a real environment quirk of a long-lived local replica that
was never actively re-verified after the process that fed it stopped,
not a code defect.

**What clients see**: every live `metricQuery`/`executiveSummary`/BI-
connector read and export continues to succeed (the replica connection
is still reachable, just behind) - `MetricResult.dataAsOf` reflects
whatever the last successful refresh tick actually saw, which may now
understate how stale the number really is if the replica itself has also
fallen behind the primary. The consistency-check job (§4) reading through
the same lagging replica can also therefore under-report drift for the
same reason.

**Recovery**: fix the underlying replication (out of this service's own
scope - `docker-compose.yml`'s own header disclaims modeling a real
read replica; provisioning one is a Terraform/infra decision, ADR-0108).

## 3. A materialized-view refresh job is lagging or failing

**Confirm it's real**:
```
curl :8600/metrics | grep analytics_mv_refresh_lag_seconds
curl :8600/metrics | grep analytics_mv_refresh_job_runs_total
SELECT view_name, refreshed_at, data_as_of, last_run_status FROM analytics_mv.mv_lineage;
```
Each job's own `ticking` guard means a slow tick is skipped (not queued)
by the next scheduled tick, never run twice concurrently - a stuck tick
shows as a gap in `analytics_mv_refresh_job_runs_total`'s rate, not
necessarily a `result="failed"` count.

**What clients see**: `MetricResult.dataAsOf` lags further behind
wall-clock time by however long the job has been stuck/failing; the
underlying `mv_*` row itself is simply not updated - no partial/corrupt
write (each tick's upserts run inside one transaction, §2.2 rule 4).

**Recovery**: nothing to do manually once the underlying cause (usually
§1's primary-down case, for the write side, or a source-schema issue in
the owning module) clears - the next tick naturally re-derives the
correct numbers from current source data with no separate backfill step.

## 4. The consistency-check job (§2.3 rule 4, ADR-0112) found a real discrepancy

**Confirm it's real**:
```
curl :8600/metrics | grep analytics_consistency_check_discrepancies_total
```
then check this service's own logs for the matching `... discrepancy:
tenant=... mv=[...] fresh=[...]` line (`MvConsistencyCheckJobService`
logs every discrepancy it finds, with both values, at `Logger.error`).

**A discrepancy here is not automatically a bug.** This job samples
`SAMPLE_SIZE = 20` already-upserted rows per view per nightly tick and
re-derives *only that exact group's* aggregate from source, tolerating
normal drift (`RELATIVE_TOLERANCE = 0.05`, `ABSOLUTE_TOLERANCE = 0.5`) -
source rows landing after the last refresh tick but before this check's
own tick can legitimately disagree with a not-yet-refreshed `mv_*` row.
What the job cannot do on its own is tell that apart from a real
aggregation bug or a source row that was deleted/changed after the `mv_*`
row was computed (both real scenarios this job's own live verification,
Phase 8, actually observed against this build's local dev data - source
rows from an earlier phase's own verification that no longer exist on
the replica producing a genuine, correctly-detected disagreement).

**Recovery**: triage by hand - re-run the refresh job for the affected
view (wait for its next scheduled tick, or trigger it manually via a
one-off script instantiating the job's own dependencies directly, the
same pattern used for this job's own Phase 8 live verification; there is
no HTTP endpoint to force either job on demand) and see if the
discrepancy clears. If it doesn't, the aggregation logic itself likely
has a real bug - compare the job's own per-view fresh-read query against
the corresponding refresh job's `SOURCE_QUERY` for a divergence.

## 5. S3 (or MinIO) is down or the bucket/credentials are wrong

**Confirm it's real**: a `POST /v1/analytics/exports` call completes its
`pending` insert (Postgres never touches S3 during that step) but the
row never leaves `pending`/flips to `failed` within a few seconds; this
service's own logs show the underlying AWS SDK error message stored
directly on the row (`GET /v1/analytics/exports/{id}`'s own
`errorMessage` field - e.g. `"Region is missing"` if the AWS SDK's
standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` env vars
are unset, a real failure mode hit and diagnosed during this phase's own
load test before those vars were set correctly).

**What this means operationally**: a report stuck at `pending` past a
few seconds with no `failed` transition either usually means the *whole
process* crashed mid-generation (Phase 6's disclosed gap: no reaper,
same in-process fire-and-forget design as Module 08's own report
generator) - check whether the process is still running at all, not
just whether S3 is reachable.

**Recovery**: fix the S3/MinIO connectivity or credentials
(`ANALYTICS_EXPORTS_S3_BUCKET`/`_ENDPOINT`/`_FORCE_PATH_STYLE`, plus the
AWS SDK's own standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`
env vars), then resubmit the export - `pending`/`failed` rows have no
built-in retry (an `Idempotency-Key` retry only returns the existing,
still-failed row unchanged).

## 6. `askAnalyticsQuestion` always returns `NL_QUERY_BRIDGE_UNAVAILABLE`

**This is expected, not an incident.** Module 10 (the natural-language
query bridge this mutation calls into) does not exist anywhere in this
platform (ADR-0111, confirmed by repo-wide grep, not assumed). The
mutation itself, the resolver, and the DI wiring are all real and
correctly connected (Phase 7's own live verification proved this end to
end) - `NotAvailableNlQueryBridgeClient` is the only registered
`NlQueryBridgeClient` today, and both of its methods unconditionally
throw. There is nothing to recover; this will keep failing until a real
Module 10 exists and `AnalyticsModule`'s provider registration is
swapped to point at it (a one-line change, no other code affected).

## 7. Migration rollback

`npm run migration:run -- migration:revert -d src/database/data-source.ts`
reverts the most recent migration only. Every migration's own `down()`
drops the table(s) it created - `1700008000000-AnalyticsExportTable`'s
`down()` drops `analytics.analytics_export` (any exports already
uploaded to S3 are orphaned, never deleted by a revert). Earlier
migrations' own `down()`s are unchanged since the phase that introduced
each.

## Known standing gaps (see the Phase 8 checklist for the full list)

- **No Prometheus alerting rules anywhere in this platform** (confirmed
  platform-wide, not a Module-09-specific gap) - every check above is
  manual (`/metrics` grep, a direct SQL query, or a log grep), never a
  page.
- **`askAnalyticsQuestion` never returns a real answer** - Module 10
  does not exist (ADR-0111). See §6.
- **No pay-rate/budget capability exists anywhere in this platform** -
  `mv_cost_vs_budget` reports hours and days, never a dollar figure
  (ADR-0109).
- **No real attrition *rate*** - `mv_attrition_by_site` reports
  `terminations_count` only; a rate needs a historical headcount
  denominator this platform doesn't have.
- **No `createScheduledExport`** (a recurring export tied to a
  `SavedReport` config) - only the one-shot `POST /v1/analytics/exports`
  exists (Phase 6).
- **No reaper for a `generate` (export) job stuck at `pending`** after a
  process crash - the same in-process fire-and-forget trade-off Module
  08's own report generator accepts.
- **No retention/lifecycle job for old exports** - no `analytics_export`
  row or its S3 object is ever deleted.
- **Authorization is creator-only** (`requestedBy`/`createdBy ===
  actorId`) for dashboards and exports - no Module 01 RBAC/sharing
  exists yet, the same disclosed gap every module in this platform
  carries.
- **`EXPORT_MAX_ROWS = 10,000`/`MAX_LIMIT = 100` are disclosed
  placeholders**, validated at this build's own small real data volume
  (a few dozen rows per view) under real concurrency
  (`docs/module-09-phase-8-load-test-results.md`), never at anything
  near their own numeric ceiling.
- **The consistency-check job (§4 above) is a sample, not an exhaustive
  recompute** - `SAMPLE_SIZE = 20` rows per view per nightly tick, by
  design (ADR-0112).
