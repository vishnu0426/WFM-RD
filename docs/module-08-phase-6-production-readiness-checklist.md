# Module 08 Phase 6 Production Readiness Checklist

## Delivered in this phase

- [x] **`ComplianceReportService`**: `requestReport` (validation +
      `RetentionPolicy`-aware `retentionExpiresAt` computation + pending
      insert + fire-and-forget generation) and `getReport` (fetch +
      on-read presigned download URL). 10 unit tests.
- [x] **Four real report builders** (`report-builders.ts`,
      `buildAdherenceSummaryReport`/`buildViolationAuditReport`/
      `buildRegulatorExportReport`): pure functions over already-fetched
      data, no I/O. 5 unit tests.
- [x] **`findViolations`** added to Phase 5's `evaluate-schedule-compliance.ts`
      (`isCompliant` is now a thin wrapper) - real per-rule-type violation
      messages, not just a boolean. 6 new unit tests; all 20 pre-existing
      `isCompliant` tests re-confirmed passing unmodified against the
      refactored implementation.
- [x] **`S3ReportStorageService`**: real `@aws-sdk/client-s3`
      upload + `@aws-sdk/s3-request-presigner` presigned-URL generation -
      this platform's first S3 integration, in either language. 4 unit
      tests (mocked SDK calls) plus real end-to-end verification against a
      local MinIO instance (see below) - not mocked-only.
- [x] **`csv.ts`**: dependency-free RFC-4180-shaped CSV builder. 6 unit
      tests covering quoting/escaping edge cases.
- [x] **REST surface**: `POST /v1/compliance/reports` +
      `GET /v1/compliance/reports/{id}`, two new `DomainError` subclasses
      (`OrgUnitScopeRequiredError` 400, `ComplianceReportNotFoundError`
      404) registered in the REST error filter.
- [x] **New governance metric** (`compliance_report_generations_total`,
      by report_type/result) - populated for the first time this phase.
- [x] **Full real E2E verification** against real, running processes and
      a real local MinIO instance (S3-protocol-compatible, no AWS account
      or cost, per explicit user choice) - not mocks: a real published
      schedule with a deliberate overtime/rest-period violation; two real
      activated `ComplianceRule`s; all four report types requested via the
      real REST API, polled to `completed`, and their real presigned
      download URLs fetched directly to confirm the actual CSV content is
      correct; `OrgUnitScopeRequiredError`/`ComplianceReportNotFoundError`
      confirmed as clean REST responses; the governance metric confirmed
      incrementing; real objects confirmed present in the MinIO bucket via
      `mc ls`. All test data, the MinIO bucket, and all five processes
      cleaned up afterward.

## Explicitly NOT done here (needs a later phase, or is a disclosed gap)

- [ ] **PDF/Excel output** - CSV only. No library or convention exists
      anywhere in this platform for either format; a real, disclosed
      scope reduction from §3.2's literal wording, not a silent one.
- [ ] **A reaper for reports stuck at `pending` after a process crash** -
      the in-process-async execution model (ADR-0105) has no equivalent to
      scheduling-service's worker reaper. Acceptable for this phase's
      low-volume, admin-triggered usage; revisit if that changes.
- [ ] **Real `RetentionPolicy` seeding and the retention/lifecycle `@Cron`
      job** - Phase 7. This phase adds only the minimal *read* side needed
      to populate `retention_expires_at` with a real, sourced value (a
      disclosed 7-year hardcoded fallback, since no policy row exists
      anywhere yet).
- [ ] **Tenant-wide (all-org-units) reports** for `overtime_audit`/
      `rest_period_audit`/`regulator_export` - `orgUnitScope` is mandatory
      for these three; one report per org unit today.
- [ ] **No RBAC/permission check on either new REST endpoint** - matches
      this platform's existing posture for every other endpoint in this
      module, not a gap specific to this phase.
- [ ] **No alerting on `compliance_report_generations_total`'s failure
      rate** - populated for the first time this phase, but nothing pages
      on it yet.
- [ ] **This local dev environment's real AWS credentials/region were
      never exercised** - verification used a local MinIO instance only,
      per explicit user choice. The `@aws-sdk/client-s3` code path itself
      is real and would work unmodified against real AWS (same client,
      same calls, only the endpoint/credentials differ), but that specific
      combination has not itself been exercised in this session.
