# Module 08 Phase 7 Production Readiness Checklist

## Delivered in this phase

- [x] **`SeedPlatformDefaultRetentionPolicy1700003100000` migration** -
      real, applied against the local Postgres. One platform-default
      `US`/3-year row. 2 unit tests.
- [x] **`S3ReportStorageService.deleteObject`** - real
      `DeleteObjectCommand`. 1 new unit test (5 total in this file).
- [x] **`ComplianceReportService.setLegalHold`** +
      `PATCH /v1/compliance/reports/{id}/legal-hold` - the retention
      job's own write path; `legal_hold` was previously unreachable from
      any API. 3 new unit tests (13 total in this file).
- [x] **`RetentionLifecycleJobService`** - this service's third `@Cron`
      job, `MIGRATOR_PG_POOL`-backed, deletes the S3 object before the
      Postgres row, `NOT legal_hold`-guarded, bounded batch size. 8 unit
      tests.
- [x] **A real, pre-existing platform bug found and fixed**:
      `TenantContextMiddleware` bound `X-Tenant-Id` case-preserved, but
      Postgres always normalizes `uuid` columns to lowercase - every
      plain-JS tenant-ownership comparison in this service silently
      rejected a caller's own rows for a non-lowercase header. Fixed at
      the single boundary point (the middleware), not per comparison
      site. 4 new unit tests for the fix itself.
- [x] **Full real E2E verification** against a real local MinIO instance
      and the real local Postgres - not mocks: three real reports
      generated through the real REST API; one backdated and confirmed
      genuinely deleted (DB row gone via both the API and an independent
      superuser query, MinIO object gone via `mc ls`); one backdated
      *and* legal-held via the real `PATCH` endpoint, confirmed surviving
      in both stores; one left unexpired, confirmed surviving; a second
      sweep confirmed idempotent (clean no-op). All test data, the MinIO
      bucket, and the one-off verification script cleaned up afterward.

## Explicitly NOT done here (needs a later phase, or is a disclosed gap)

- [ ] **Comprehensive `RetentionPolicy` jurisdiction coverage** - one
      seeded `US` row; every other jurisdiction still falls to Phase 6's
      disclosed 7-year hardcoded fallback.
- [ ] **No audit trail for legal-hold changes** - who placed/removed a
      hold, or why, is not recorded. This service already has
      `AuditGrpcClientService` wired in (Phase 5) and could record this
      the same way; this phase does not add that call.
- [ ] **No manual-trigger endpoint for the retention sweep** - real
      verification used a standalone script instantiating the job
      directly; there is no operational way to force a sweep on demand
      in the running service today.
- [ ] **The tenant-id case-sensitivity bug was fixed in Module 08 only** -
      sibling services almost certainly carry an identical copy of
      `TenantContextMiddleware` with the identical gap. Not verified or
      fixed elsewhere - flagged here as a real, likely platform-wide
      issue worth a dedicated look.
- [ ] **No RBAC/permission check on the legal-hold endpoint** - matches
      this module's own §8 non-goal, not a gap specific to this phase.
- [ ] **No alerting on either new metric**
      (`compliance_retention_lifecycle_job_runs_total`/
      `_deletions_total`) - populated for the first time this phase, but
      nothing pages on either yet.
