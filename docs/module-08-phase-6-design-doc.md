# Module 08 Phase 6 Design Doc — Adherence & Compliance: `generateComplianceReport` + S3 Export

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08). No changes to any other
module - Phase 6 reuses Phase 3/5's existing gRPC clients and adds no new
cross-service surface.
**Scope:** §3.2/§1's own line: async `generateComplianceReport`, all four
report types (`adherence_summary`, `overtime_audit`, `rest_period_audit`,
`regulator_export`), S3 export. All four shipped (ADR-0105).

## Problem

Four real gaps, none with a precedent anywhere in this platform:

1. **No S3 (or S3-compatible) integration exists anywhere in this
   monorepo**, in either language.
2. **No PDF/Excel generation library exists anywhere either**, and no
   export feature of any kind to mirror a format convention from.
3. **The only "submit via API, poll for a result" precedent
   (scheduling-service's `ScheduleJob`) is a separate-worker-process
   design** built for CPU-bound CP-SAT solving - a workload profile this
   feature (I/O-bound aggregation + a handful of gRPC calls + one file
   upload) doesn't share.
4. **`overtime_audit`/`rest_period_audit`/`regulator_export` all need a
   jurisdiction to audit against** - the same class of gap ADR-0101/0102/0104
   each hit and resolved differently for their own integration point.

See ADR-0105 for the full reasoning; in short: in-process fire-and-forget
execution (no separate worker), CSV output (no new heavyweight dependency
for a genuinely tabular format), a real S3 client verified against a local
MinIO instance (per the user's explicit choice - no real AWS account or
cost involved), and jurisdiction resolved via Phase 3's existing
`CalendarGrpcClientService.getWorkingTimeRules` (the same call the
timezone resolver already makes).

## Decision

- `ComplianceReportService.requestReport`: validates `orgUnitScope` is
  present for the three types that need it (`OrgUnitScopeRequiredError`
  otherwise), computes `retentionExpiresAt` (a real, disclosed
  `RetentionPolicy` lookup - tenant-specific, then platform-default-by-
  jurisdiction, then a hardcoded 7-year fallback, since nothing seeds a
  `RetentionPolicy` row until Phase 7), inserts a `pending` row, and fires
  `generate()` without awaiting it.
- `generate()`: dispatches to one of four builders (`report-builders.ts`,
  pure functions given already-fetched data), serializes to CSV
  (`csv.ts`, a dependency-free RFC-4180-shaped builder), uploads to S3
  (`S3ReportStorageService`), and marks the row `completed`/`failed`.
- `overtime_audit`/`rest_period_audit` reuse Phase 5's
  `evaluate-schedule-compliance.ts` verbatim via a new `findViolations`
  export (`isCompliant` is now a thin wrapper over it) - real published
  shifts for the period, checked against the org unit's actual active
  rule, one CSV row per violation found.
- `regulator_export` combines the org unit's full active `ComplianceRule`
  set (with citations) and both audits' violations into one
  `recordType`-discriminated table - not a fifth report design.
- `adherence_summary` reads stored `AdherenceScore` rows directly (§0.5's
  reproducibility promise - no recomputation), optionally filtered to one
  org unit's roster.
- `GET /v1/compliance/reports/{id}` computes a presigned S3 GET URL
  (1-hour expiry) on every read, never stored - a stored presigned URL
  would silently expire with no signal to the caller.

## Blast radius
- New `src/compliance/reports/` (csv.ts, s3-report-storage.service.ts,
  report-builders.ts, compliance-report.service.ts,
  compliance-report.controller.ts, dto/, errors/). Extended
  `evaluate-schedule-compliance.ts` (`findViolations`, `isCompliant`
  unchanged in behavior - 20 pre-existing tests confirmed passing
  unmodified). `MetricsService`/`compliance.module.ts`/`domain-error.filter.ts`
  additive changes. Two new dependencies (`@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`) - audited, zero new vulnerabilities
  versus the pre-existing baseline. One new ADR (0105).
- Zero changes to any other module, and zero changes to scheduling-service
  or root beyond what Phase 5 already added (this phase's gRPC calls reuse
  existing clients/RPCs entirely).

## Verification

Real, running processes for every claim below - core (gRPC `:5099`),
attendance-leave-service (gRPC `:7099`), scheduling-service (`:8100`/
`:8102` + worker), Module 08 (`:8500`/gRPC `:7100`), and a real local
MinIO instance (`:9000`, S3-protocol-compatible, no AWS account or cost),
all against the real local Postgres:

- A real published schedule (11h shift + a 5h rest gap, deliberately
  chosen to violate both a to-be-created 8h daily overtime threshold and a
  10h rest-period floor) submitted, solved, and published through
  scheduling-service's real API.
- Two real `ComplianceRule`s (`overtime_threshold` 8h,
  `rest_period_minimum` 10h) created and activated through Module 08's
  real GraphQL API (each satisfying Phase 5's impact-preview gate first).
- `POST /v1/compliance/reports` called for real, for all four report
  types, against Module 08's real REST API - each returned `pending`
  immediately, then polled via `GET .../{id}` to `completed`, with a real
  `s3://` `fileUri` and a real presigned `downloadUrl`.
- The presigned URL for each report was fetched directly (no
  authentication beyond the URL itself, proving the signature is real and
  valid) and its CSV content confirmed correct: `overtime_audit` showed
  the exact 11h/8h violation; `rest_period_audit` showed the exact 5h/10h
  gap; `regulator_export` combined both active rules and both violations
  in one discriminated table; `adherence_summary` echoed a real seeded
  `AdherenceScore` row verbatim.
- A real, pre-existing test-fixture gap was hit and fixed the same way
  Phase 4/5 each hit it once already: no `WorkingTimeCalendar` row existed
  for the freshly-seeded org unit, so jurisdiction resolution returned an
  empty country code and the first `overtime_audit` attempt correctly
  produced a header-only (zero-violation) report rather than an error -
  genuinely correct behavior for "no rule matches this org unit's
  resolved jurisdiction," not a bug, but not the scenario being tested
  either. Fixed by seeding a real `WorkingTimeCalendar` row, then
  re-verified successfully.
- `OrgUnitScopeRequiredError` (missing `orgUnitScope` on `overtime_audit`)
  and `ComplianceReportNotFoundError` (unknown report id) both confirmed
  as clean, correctly-shaped REST error responses.
- `compliance_report_generations_total` confirmed incrementing correctly
  per report type/result via `/metrics`.
- Real objects confirmed present in the MinIO bucket via `mc ls`,
  matching every report generated.
- All test data (tenant, org unit, employee, calendar, schedule, rule,
  adherence score, report, audit-log rows) deleted afterward; the MinIO
  bucket removed; all five processes killed and ports confirmed free.
- Full suites re-run clean: Module 08 152 unit tests (up from 121),
  typecheck/lint/build clean; root's monorepo-wide `npm test` 115 suites/
  640 tests passing.

## Explicit assumptions (spec was ambiguous or silent here)
1. **In-process fire-and-forget execution, not a separate worker process** -
   a deliberate departure from scheduling-service's `ScheduleJob` shape,
   justified by the I/O-bound (vs. CPU-bound) workload profile. See
   ADR-0105's consequences for the real trade-off this accepts (a crashed
   process leaves a row stuck at `pending` forever - no reaper exists).
2. **CSV, not PDF/Excel** - no library or convention exists anywhere in
   this platform for either format; every report type here is
   fundamentally tabular.
3. **`orgUnitScope` is mandatory, not merely optional, for three of the
   four report types** - despite the schema's nullable column - since
   each needs exactly one org unit to resolve a jurisdiction against.
4. **`RetentionPolicy` lookup is a real but minimal read**, added ahead of
   Phase 7's own seeding/lifecycle-job work, purely because
   `retention_expires_at` is `NOT NULL` and needs a real, sourced value
   from the first row onward (Phase 1's own posture). Falls back to a
   disclosed hardcoded 7 years when no policy row exists, which is always,
   today.
5. **A presigned download URL is computed fresh on every `GET`, never
   stored** - the canonical `fileUri` (`s3://...`) is the only thing
   persisted.

## Out of scope for this phase (do not build yet)
- PDF/Excel output - a real, disclosed scope reduction, not a silent one.
- The retention/lifecycle `@Cron` job and real `RetentionPolicy` seeding -
  Phase 7, unaffected by this phase's minimal read-side addition.
- A reaper for reports stuck at `pending` after a crash - a real,
  disclosed gap from the in-process-async choice; revisit if report volume
  or generation cost ever grows enough to matter.
- Tenant-wide (all-org-units) reports for `overtime_audit`/
  `rest_period_audit`/`regulator_export` - one report per org unit today.
- RBAC/permission checks on `POST`/`GET /v1/compliance/reports*` - matches
  this platform's existing posture for every other endpoint in this
  module.
