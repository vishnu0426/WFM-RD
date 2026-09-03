# Module 08 Runbook — Adherence & Compliance

Operational reference for `adherence-compliance-service` (Phases 1-8).
Every check below is a direct SQL query against `compliance.*` (any role
with `SELECT` - `agno_migrator` locally), a scrape of the one `/metrics`
endpoint (`GET :8500/metrics`), or a `curl` against the real REST/GraphQL
surface - see `observability/grafana-dashboard-module-08.json` for the
panelled view of the same data.

## 0. One process, four real external dependencies

`adherence-compliance-service` (`node dist/src/main.js`) is a single
process: the REST/GraphQL API, the gRPC *server*
(`ComplianceRuleService.GetActiveRule`/`ValidatePolicyAgainstFloor`, port
7100), and three `@Cron` jobs (`AdherenceDailyRollupJobService`,
`AdherenceWeeklyMonthlyRollupJobService`, `RetentionLifecycleJobService`)
all run in-process. Four real dependencies, each with its own documented
failure posture:

- **Postgres** (`compliance` schema, RLS via `withTenantConnection` on
  every request-path query, ADR-0093; a second, separate `agno_migrator`
  connection pool for the three cross-tenant `@Cron` jobs, ADR-0098/0106) -
  `GET /readyz` checks the request-path connection only.
- **core's gRPC server** (port 5000 by default, `CORE_GRPC_URL`) - called
  by `EmployeeGrpcClientService`/`CalendarGrpcClientService`/
  `AuditGrpcClientService`. See §1.
- **scheduling-service's gRPC server** (port 8102 by default,
  `SCHEDULING_GRPC_URL`) - called by `ScheduleQueryGrpcClientService`
  (ADR-0103). See §2.
- **S3 (or an S3-compatible endpoint, e.g. local MinIO for dev/test,
  ADR-0105)** - called by `S3ReportStorageService`. See §3.

## 1. core's gRPC server is down or slow

**Confirm it's real**: `curl :5000/healthz`, or `lsof -i :5000` (a real
macOS quirk hit repeatedly in this build: AirPlay Receiver/ControlCenter
squats on port 5000 by default on this OS - a `GRPC_URL` override on
core's own process, not a Module 08 config, is the fix when that happens
locally). This service's own logs show the underlying error wrapped as
`EmployeeGrpcClientUnavailableError`/`CalendarGrpcClientUnavailableError`
(both extend `DomainError` since Phase 5/ADR-0104) or a logged (never
thrown) warning from `AuditGrpcClientService`'s best-effort call.

**What clients see**:
- The rollup jobs (`TimezoneResolverService`) fall back to UTC per
  employee/org unit rather than failing the whole tick - ADR-0099's own
  disclosed posture, unchanged since Phase 3.
- `generateRuleChangeImpactPreview` and any org-unit-scoped
  `generateComplianceReport` (`overtime_audit`/`rest_period_audit`/
  `regulator_export`) throw `EmployeeGrpcClientUnavailableError`/
  `CalendarGrpcClientUnavailableError` - fail closed, no silent partial
  result (ADR-0104/0105).
- `activateComplianceRule`'s flagged-activation audit call
  (`AuditGrpcClientService.recordEvent`) is best-effort - a failure here
  is logged (`Failed to record activation audit event for rule ...`) but
  never blocks or fails the activation itself, which already committed
  (ADR-0104).

**Recovery**: nothing to do manually - the next call after core recovers
succeeds normally.

## 2. scheduling-service's gRPC server is down or slow

**Confirm it's real**: `lsof -i :8102`, or check scheduling-service's own
`/healthz` (`:8100/healthz`). This service's own logs show
`ScheduleQueryGrpcClientUnavailableError` (a real `DomainError` since
Phase 8/ADR-0107 - previously a bare `Error`, surfacing as a generic 500).

**What clients see**: `generateRuleChangeImpactPreview` and
`overtime_audit`/`rest_period_audit`/`regulator_export` reports fail the
same way as §1 - fail closed. `generateComplianceReport`'s failure is
swallowed internally and turned into a `status: failed` row (ADR-0105's
in-process fire-and-forget design) rather than a thrown error the caller
sees synchronously - poll `GET /v1/compliance/reports/{id}` and check
`status`, not the original `POST`'s response.

**Recovery**: nothing to do manually for a preview retry. A `failed`
report has no automatic retry - the caller must submit a new
`POST /v1/compliance/reports` (there is no "retry this report" endpoint).

## 3. S3 (or MinIO) is down or the bucket/credentials are wrong

**Confirm it's real**: a `generateComplianceReport` call completes its
`pending` insert (Postgres never touches S3 during that step) but the
row never leaves `pending`/flips to `failed` within a few seconds; this
service's own logs show `Failed to generate compliance report ...:` with
the underlying AWS SDK error. `RetentionLifecycleJobService`'s own sweep
logs `Failed to delete expired compliance report ...:` per affected row
without aborting the rest of its batch (ADR-0106).

**What this means operationally**:
- A report stuck at `pending` past a few seconds with no `failed`
  transition either usually means the *whole process* crashed mid-generation
  (ADR-0105's disclosed gap: no reaper, unlike scheduling-service's
  `ScheduleJob` worker pool) - check whether the process is still running
  at all, not just whether S3 is reachable.
- A retention-lifecycle deletion failure leaves the Postgres row in place
  (deliberately - ADR-0106's "S3 first, Postgres second" ordering means a
  failure here is always safely retried the next day's tick, never an
  orphaned S3 object with no surviving pointer).

**Recovery**: fix the S3/MinIO connectivity or credentials
(`COMPLIANCE_REPORTS_S3_BUCKET`/`_ENDPOINT`/`_FORCE_PATH_STYLE`, plus the
AWS SDK's own standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`
env vars), then either resubmit the report (`pending`/`failed` rows have
no built-in retry) or wait for the next retention tick (self-heals with
no manual action).

## 4. A rollup job (`AdherenceDailyRollupJobService`/`AdherenceWeeklyMonthlyRollupJobService`) is lagging or failing

**Confirm it's real**:
```
curl :8500/metrics | grep compliance_rollup_job_lag_seconds
curl :8500/metrics | grep compliance_rollup_job_runs_total
```
§0.5's own disclosed target for the 15-minute tick: complete within 5
minutes of window close (the histogram's own `help` text/Phase 1 code
comment - not a hard SLA, this build's own reasonable interpretation of
§0.5, never given a literal numeric target in the module prompt beyond
that). A `ticking` guard means a slow tick is skipped (not queued) by the
next scheduled tick, not run twice concurrently - a stuck tick shows as a
gap in `compliance_rollup_job_runs_total`'s rate, not an error count
necessarily.

**What clients see**: `AdherenceScore` rows lag behind real-time by
however long the job has been stuck/failing - `§0.5`'s reproducibility
promise (`same period requested twice returns identical numbers`) is
unaffected either way, since it only speaks to what's already been
computed, not to computation *latency*.

**Recovery**: nothing to do manually once the underlying cause (usually
§1's core-gRPC-down case, via `TimezoneResolverService`) clears - the next
tick's own trailing-window re-scan (`ADHERENCE_DAILY_ROLLUP_TRAILING_DAYS`/
`ADHERENCE_WEEKLY_MONTHLY_ROLLUP_TRAILING_DAYS`) naturally catches up
without any separate backfill step (the upsert key makes every tick
idempotent, §2.2 rule 4).

## 5. `RetentionLifecycleJobService` isn't cleaning up expired reports

**Confirm it's real**:
```
curl :8500/metrics | grep compliance_retention_lifecycle
SELECT count(*) FROM compliance.compliance_report WHERE retention_expires_at < now() AND NOT legal_hold;
```
(the second, run as `agno_migrator`, bypasses RLS to see every tenant at
once - the same connection the job itself uses). Runs once daily at 3am
(`0 3 * * *`) - a non-zero count here between runs is expected, not a
bug, until the next tick.

**Manually toggle a legal hold** (no audit trail exists for this - a real,
disclosed gap, ADR-0106):
```
curl -X PATCH :8500/v1/compliance/reports/<id>/legal-hold \
  -H "X-Tenant-Id: <tenant>" -H "Content-Type: application/json" \
  -d '{"legalHold": true}'
```

**Recovery**: if the job's own tick is failing outright (not just slow),
see §3 (S3 unavailability is the most likely cause, since every deletion
attempt touches S3 first) - `compliance_retention_lifecycle_job_runs_total{result="error"}`
distinguishes "the whole tick threw" from
`compliance_retention_lifecycle_deletions_total{result="error"}`
("one row's deletion failed, the tick itself completed and moved on").

## 6. A tenant sees "not found" for a row that should be theirs

**A real, fixed bug, worth knowing the shape of** (ADR-0106, Phase 7):
`X-Tenant-Id` is trusted verbatim (ADR-0014's own header-trust placeholder
posture) and lowercased once, in `TenantContextMiddleware`, before
binding context - Postgres always returns a `uuid` column's value in
canonical lowercase, so a caller sending a non-lowercase tenant id would,
before this fix, have every plain-JS ownership comparison in this service
silently reject their own rows. If this symptom reappears, check whether
some *other* new comparison site was added that bypasses
`TenantContextService.requireTenantId()`'s now-normalized value (e.g. a
raw header read) rather than assuming the fix itself regressed.

## 7. Migration rollback

`npm run migration:run -- migration:revert -d src/database/data-source.ts`
reverts the most recent migration only.
`1700003100000-SeedPlatformDefaultRetentionPolicy`'s `down()` only removes
the one platform-default `US` row it inserted - safe, no data loss beyond
that row itself. Every earlier migration's own `down()` caveats (Phase
1-6) are unchanged.

## Known standing gaps (see the Phase 8 checklist for the full list)

- **No Prometheus alerting rules anywhere in this platform** (confirmed
  platform-wide, not a Module 08-specific gap) - every check above is
  manual (`/metrics` grep or a direct SQL query), never a page.
- **No latency histogram beyond `http_request_duration_seconds` and
  `compliance_rollup_job_lag_seconds`** - `ValidatePolicyAgainstFloor`
  gRPC calls, impact-preview generation, report generation, and the
  retention lifecycle tick all have only outcome counters, no duration
  measurement.
- **`AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` have no read API
  anywhere** (GraphQL or REST) - the rollup jobs compute real data
  nothing outside direct SQL access can ever read back. The single
  largest functional gap in this module as of Phase 8 (ADR-0107).
- **No reaper for a `generateComplianceReport` job stuck at `pending`**
  after a process crash - unlike scheduling-service's `ScheduleJob`
  worker pool. A real, disclosed trade-off of this module's in-process
  fire-and-forget design (ADR-0105).
- **No audit trail for `legal_hold` changes** - who placed/removed a hold,
  or why, is not recorded anywhere (ADR-0106).
- **Jurisdiction resolution is country-level only**, everywhere it's
  used (`OrgUnit.countryCode`) - no state/subdivision precision anywhere
  in this module's integration points (ADR-0101/0102/0104/0105).
- ~~No RBAC/permission check anywhere in this service~~ - closed by
  ADR-0161: `src/auth/` now gates every write and read this module
  exposes via REST/GraphQL. Check `compliance_rbac_denials_total{reason}`
  for denial volume/cause. `AdherenceScoreResolver.adherenceScoreToday`
  and both gRPC controllers remain deliberately ungated - see the ADR for
  why.
