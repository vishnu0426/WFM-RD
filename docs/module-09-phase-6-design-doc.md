# Module 09 Phase 6 Design Doc — Analytics & Reporting: Async Export Job

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09).
**Scope:** §8's own Phase 6 line: "BI connector + async exports. REST metric endpoint, export job pattern." The REST metric endpoint (§4.2's `GET /v1/analytics/metrics/{metricName}`) already shipped in Phase 4 (see that phase's own design doc for why). This phase's actual remaining scope: `POST /v1/analytics/exports` + `GET /v1/analytics/exports/{id}` + `GET /v1/analytics/exports/{id}/download` - "async job, same pattern as Module 08's report generator" (§1).

## Problem

"Same pattern as Module 08's report generator" needed to be verified against that service's actual code, not assumed from the phrase - and doing so surfaced a real gap in the thing this module was told to copy. **Module 08's report generator has zero `Idempotency-Key` handling** (confirmed by `grep`, not assumed) - `POST /v1/compliance/reports` accepts plain DTO input with no idempotency protection at all. But this module's own §4.2 explicitly requires `Idempotency-Key` for `POST /v1/analytics/exports`. So "the same pattern" and "what this endpoint's own spec requires" genuinely diverge on this one point, and the right call is to keep §4.2's explicit requirement (it's this module's own spec, stated directly) while building the idempotency mechanism itself, since Module 08 has none to copy.

That, in turn, raised a design question: **which of this platform's two existing idempotency mechanisms should this module reuse?** Neither fits without adding something this service doesn't otherwise need:
- The root app's generic Redis-backed `idempotency.interceptor.ts` is not reachable from a standalone service (different process, different codebase) without introducing Redis as a brand-new dependency purely for one endpoint.
- `scheduling-service`'s own Postgres `idempotency_keys` table is that service's own schema, not something `analytics-reporting-service` can query directly.

Decision: implement it directly on `analytics_export` itself - a nullable `idempotency_key` column with a partial unique index (`tenant_id, idempotency_key`), checked proactively before insert. Postgres is already this service's only stateful dependency; this needs nothing new.

A second finding, confirmed by reading Module 08's actual `requestReport`/`generate` methods rather than inferring from the ADR title alone: **the async model is fire-and-forget and in-process, not a queue or worker process** - `void this.generate(...).catch(...)`, never awaited by the request handler, no separate worker, no reaper. Copied here exactly, including its disclosed consequence: a crash mid-generation leaves a row stuck at `pending` forever.

A third, smaller finding while wiring the export's actual data read: **exports need every dimension column, not just the single `value` column live `metricQuery` reads** - a useful CSV needs `period_type`/`org_unit_id`/`cost_center`/etc. alongside the metric's own value, not a bare number column. `MetricQueryEngineService` gained a new public `queryForExport` method for this, reusing (never duplicating) the exact same whitelist check `query()` already enforces, with a larger row cap (`EXPORT_MAX_ROWS = 10,000`, a disclosed placeholder) and no `+1`-row trend-comparison logic (a flat export has nothing to compare against).

## Decision

**`AnalyticsExportService.requestExport`**: checks for an existing row matching `(tenantId, idempotencyKey)` first (only if a key was supplied); if found, returns it unchanged and never re-triggers generation. Otherwise inserts a `pending` `AnalyticsExport` row, returns it immediately, and fires `generate` without awaiting it - the HTTP response *is* the "accepted" state.

**`generate`** (private, fire-and-forget): calls `MetricQueryEngineService.queryForExport`, builds a CSV (own copy of Module 08's dependency-free `csv.ts`, ADR-0039) with every dimension column plus the value column plus a trailing `data_as_of` column on every row, uploads it via `ExportStorageService` (own copy of Module 08's `S3ReportStorageService`, presigned-download-URL shape, MinIO-compatible via the identical `_ENDPOINT`/`_FORCE_PATH_STYLE` override pattern), and marks the row `completed`/`fileUri`/`rowCount` on success or `failed`/`errorMessage` on any thrown error - the `try`/`catch` inside `generate` itself, not the outer `.catch()` (which only logs an *unhandled* rejection that should never actually occur, since `generate` catches its own failures).

**`GET /v1/analytics/exports/{id}/download`** redirects to a 1-hour presigned S3/MinIO URL rather than streaming the file through this API - same reasoning as Module 08's own copy: a leaked URL isn't a standing access grant, and this service never needs to hold the whole export in memory to serve a download.

**Authorization**: `getExport`/`getDownloadUrl` check `requestedBy === actorId`, the same creator-only posture Phase 4 established for dashboards (and the same disclosed gap: no Module 01 RBAC/sharing).

## Blast radius

- New: `analytics.analytics_export` table/entity, `AnalyticsExportService`, `ExportStorageService`, `csv.ts`, `AnalyticsExportsController`, one new metric (`analytics_exports_total`), two new `DomainError` subclasses.
- `MetricQueryEngineService` gains one new public method (`queryForExport`) and an internal refactor (`resolveMetric` extracted, shared by `query()` and `queryForExport()`) - `query()`'s own external behavior is unchanged (verified by its existing 15 tests still passing unmodified).
- New dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (same versions Module 08 already uses).
- Zero modification to any Module 02–08 table, migration, schema, or running code.
- `docker-compose.yml`: no change (S3/MinIO is external infrastructure the same way real AWS would be - Module 08's own service doesn't add a MinIO container either).

## Rollback plan

Revert `AnalyticsModule`'s two new providers/controller, remove `queryForExport` and the `resolveMetric` refactor from `MetricQueryEngineService` (or leave the refactor in place - it's behavior-preserving for `query()`), revert `DomainErrorFilter`'s two new entries, run this phase's migration's own `down()` (drops the table), remove this doc, its checklist, and the two new AWS SDK deps from `package.json`. Nothing outside this service depends on this phase's surface yet.

Verified against a real local Postgres and **real MinIO** (installed locally, a genuine S3-compatible target, not mocked) - not just unit tests: `POST /v1/analytics/exports` for `adherence_trend` returned a `pending` row, completed within ~200ms to `completed` with a real `s3://` URI and `rowCount: 8`; `GET .../download` redirected to a real presigned MinIO URL whose content was downloaded and hand-verified against the real 8 rows in `mv_adherence_trend_rollup`, correctly including the `period_type` dimension column and a `data_as_of` column on every row; a retry with the same `Idempotency-Key` returned the identical export id without creating a duplicate; a different actor was correctly rejected reading the first actor's export (`ANALYTICS_EXPORT_NOT_FOUND`); an export for a nonexistent metric was accepted (fire-and-forget), then polled and found `failed` with the real `MetricNotFoundError` message attached; downloading a `failed` export was correctly rejected (`ANALYTICS_EXPORT_NOT_READY`). 129 unit tests pass (up from 110 in Phase 5), lint/typecheck/build clean.

## Explicit assumptions (spec was ambiguous or silent here)

1. **§4.2's REST metric endpoint shipped in Phase 4, not this phase** - see that phase's own design doc.
2. **`Idempotency-Key` is implemented via a Postgres partial unique index on this module's own table**, not either of this platform's two existing idempotency mechanisms - see Problem.
3. **The async model is fire-and-forget/in-process, confirmed against Module 08's actual code**, not assumed from "same pattern" phrasing.
4. **`EXPORT_MAX_ROWS = 10,000`** is a disclosed placeholder ceiling, not a load-tested number - revisit with Phase 8's real load test.
5. **Download is a redirect to a presigned URL**, never streamed through this API - same as Module 08's own copy.
6. **No retention/lifecycle job, no `legal_hold` column** - no §5b-equivalent legal retention requirement exists anywhere in this module's own spec for an analytics export (unlike Module 08's `ComplianceReport`).
7. **Authorization is creator-only** (`requestedBy === actorId`) - same disclosed Module-01-RBAC gap Phase 4 already flagged for dashboards.

## Out of scope for this phase (do not build yet)

- `createScheduledExport` (§4.1's GraphQL mutation) - a materially different feature (a recurring, cron-triggered export tied to a `SavedReport` config) than this phase's one-shot `POST /v1/analytics/exports`. No phase in this module's own §8 build-phase list is explicitly assigned to build it - flagged as a real, disclosed gap (same posture as Phase 4's Module 01 RBAC flag), not silently deferred.
- A retention/lifecycle job for old exports (no `analytics_export` row or its S3 object is ever deleted).
- `askAnalyticsQuestion` - Phase 7.
- The §0.5 load test that would give `EXPORT_MAX_ROWS` a real number to check against, and the consistency-check job - Phase 8.
