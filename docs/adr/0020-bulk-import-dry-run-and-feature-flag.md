# ADR-0020: Bulk HRIS import - dry-run-by-default, feature-flagged commit, fire-and-forget async job

## Context
§3.2 and §0.5 together specify a lot for one endpoint: async (`202` + `job_id`, poll
`GET /v1/jobs/{job_id}`), a `dry_run` mode returning a diff report
(creates/updates/conflicts) without committing, and - §0.5's progressive-delivery
line - the destructive (non-dry-run) mode gated behind a feature flag enabled per
tenant, since this is "the highest-blast-radius endpoint in this module (can
bulk-modify 10k+ employees in one call)."

## Decision

**`dryRun` defaults to `true` when omitted.** Not stated explicitly by §3.2, but the
safest reading of §0.5's "must ship behind a feature flag with a dry-run mode... before
the destructive mode is enabled per tenant" - a caller who doesn't think to pass
`dryRun: false` should get the safe behavior, not the destructive one.

**A minimal, reusable feature-flag table** (`org.feature_flags`, `(tenant_id,
flag_key) -> enabled`), not a rules/percentage-rollout engine - §0.5 asks for
per-tenant gating, nothing more sophisticated. `bulk_import_destructive` is the one
key this phase uses; the table and `FeatureFlagsService` are written to be reusable
by any future feature needing the same per-tenant on/off switch, and are exposed
through a `featureFlag`/`setFeatureFlag` GraphQL query/mutation (not named by §3.1,
added because a flag nothing can toggle through the API is not meaningfully
"feature-flagged").

**Fire-and-forget in-process async, not a real job queue.** `BulkImportService.startImport`
creates the `BulkImportJob` row (fast, awaited) and calls `processImport` *without*
awaiting it, returning immediately - satisfying §3.2's `202` + poll pattern. No
BullMQ/Redis/SQS-backed queue exists in this repo; this is a known, explicitly
flagged simplification (see the production readiness checklist) - a real deployment
processing "10k+ employees in one call" needs a durable, horizontally-scalable job
queue, not an un-awaited promise in the same process that accepted the HTTP request
(a process restart mid-import loses the in-flight job with no automatic resume,
unlike the decay job's checkpoint-based resumability, ADR-0017).

**Dry-run and commit share one diff-building pass** (`BulkImportService.buildReport`)
- `commit` only ever applies records the same pass already classified as
`creates`/`updates`, and skips anything in `conflicts`. This guarantees the diff
report a caller saw is exactly what a subsequent (or the same, non-dry-run) call
would do - there is no second, independently-written "actually do it" code path that
could drift from what dry-run predicted.

**Idempotency via `Idempotency-Key`** (§3.2's cross-cutting requirement): a
`(tenant_id, idempotency_key)` partial unique index, checked at the start of
`startImport` - a repeated request with the same key returns the existing job
instead of starting a second import.

## Consequences
- A crashed process loses any bulk import mid-flight with no automatic resume -
  explicitly flagged, not a parity gap with the decay job's own resumability
  (ADR-0017), which was a named §5 requirement; §3.2/§0.5 do not ask for
  resumability on bulk import specifically, just the async-job/dry-run/feature-flag
  shape this ADR delivers.
- `commit`'s per-record writes go through the same `EmployeesService.create`/
  `update`/`transfer` (and therefore the same `EmployeeChanged` outbox events,
  ADR-0019) as any other caller - a bulk import is not a special, event-skipping
  write path.
- No CSV/XLSX ingestion - `BulkImportRequestDto.records` is a JSON array. Real HRIS
  systems (Workday, SuccessFactors) commonly export CSV; a format adapter in front of
  this endpoint is future work this phase doesn't build, since §3.2 doesn't specify
  the wire format and JSON is the natural fit for this repo's existing REST/validation
  stack (`class-validator` DTOs).
