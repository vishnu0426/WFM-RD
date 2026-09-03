# Module 08 Phase 7 Design Doc — Adherence & Compliance: Retention/Lifecycle

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08). No changes to any other
module.
**Scope:** §5b/ADR-0096's own deferred line: "the retention/lifecycle
`@Cron` job, `RetentionPolicy` seeding, and the legal-hold-guarded delete
ADR-0096 designs the schema around." All three shipped (ADR-0106).

## Problem

Three real gaps, each needing a decision before writing any code:

1. **No `RetentionPolicy` row exists anywhere** - Phase 6 added a read
   path (tenant-specific → platform-default-by-jurisdiction → a disclosed
   7-year hardcoded fallback) but deferred real seeding.
2. **`legal_hold` had no write path anywhere** - the column, and
   ADR-0096's own guard clause design, existed since Phase 1; nothing let
   a caller ever set it to `true`, making the guard untestable and the
   column dead weight from the API's own perspective.
3. **ADR-0096 left "S3 archival/deletion of `fileUri`'s underlying
   object" as an explicitly separate, unresolved concern** - deleting the
   Postgres row alone would leave orphaned S3 objects accumulating
   forever.

## Decision

- **A minimal, real `RetentionPolicy` seed** (one platform-default `US`
  row, `retention_years: 3`) - deliberately not a legal database. §5b's
  own framing ("needs periodic legal review") governs this directly:
  seeding many jurisdictions with confidently-asserted values this session
  has no authority to certify would be worse than one clearly-a-starting-
  point row plus Phase 6's existing disclosed fallback for everything else.
- **`legal_hold` gets a real write path**: `PATCH /v1/compliance/reports/{id}/legal-hold`.
  No new authorization model - matches §8's own no-RBAC-in-Module-08
  non-goal.
- **`RetentionLifecycleJobService`**: this service's third `@Cron` job,
  same shape as Phase 3's two rollup jobs (`MIGRATOR_PG_POOL`-backed
  cross-tenant sweep, a `ticking` overlap guard, `getNumberConfig`-tuned
  batch size, metrics on every run). Daily (`0 3 * * *`), not
  15-minutes - retention isn't latency-sensitive. Deletes the S3 object
  *before* the Postgres row (a crash mid-way leaves a safely-retryable
  orphaned row, never an unrecoverable orphaned object with no surviving
  pointer). A genuine hard delete - no archive tier, matching ADR-0096's
  own explicit framing.

## Blast radius
- New `1700003100000-SeedPlatformDefaultRetentionPolicy.ts` migration (run
  against the real local Postgres). New
  `src/compliance/reports/retention-lifecycle-job.service.ts`,
  `dto/set-legal-hold.dto.ts`. Extended `S3ReportStorageService`
  (`deleteObject`), `ComplianceReportService` (`setLegalHold`,
  `getOwnedReport` extracted), `ComplianceReportController` (`PATCH`),
  `MetricsService`, `ComplianceModule` (second `migratorPoolProvider`
  registration - see that provider's own updated doc comment). One new
  ADR (0106).
- **A real, pre-existing platform bug found and fixed**:
  `TenantContextMiddleware` bound the `X-Tenant-Id` header verbatim
  (case-preserved), but Postgres always returns a `uuid` column's value in
  canonical lowercase - every plain-JS `tenantId1 !== tenantId2` ownership
  check in this service (`ComplianceReportService.getOwnedReport`,
  `ComplianceRuleService.getOwnedRule`/`activateRule`) silently rejected a
  caller's own rows as not-found whenever the header arrived in a
  non-lowercase form (e.g. macOS `uuidgen`'s own default uppercase form -
  exactly what this phase's own verification used). Fixed by lowercasing
  once, at the single boundary where the header enters the system
  (`TenantContextMiddleware`), rather than patching each comparison site.
  RLS itself was never affected (`::uuid` casts normalize case for SQL
  comparisons) - only this service's own application-level string
  comparisons were. **Disclosed, not fixed**: sibling services likely
  carry an identical copy of this middleware with the identical gap - not
  verified or fixed here, out of this phase's own scope (Module 08 only).

## Verification

Real, running processes for every claim below - Module 08 alone
(`:8500`), a real local MinIO instance (`:9000`), and the real local
Postgres. No other service was needed this phase (`RetentionLifecycleJobService`
has no gRPC dependency at all, and `adherence_summary` reports need no
`orgUnitScope`, so no cross-service call was required to generate a real
report to test cleanup on):

- Three real `adherence_summary` reports generated end to end through
  Module 08's real REST API, each with a real object actually uploaded to
  MinIO - discovered and fixed the tenant-id case bug above in the
  process (the very first `GET` after a successful `POST`, using the same
  uppercase-header tenant id, returned a false `COMPLIANCE_REPORT_NOT_FOUND`
  until the middleware fix was applied and the service rebuilt/restarted).
- Report A's `retention_expires_at` backdated to yesterday via direct SQL
  (the only way to exercise a multi-year retention window in a live
  session); report B backdated identically, then placed under legal hold
  via the real `PATCH .../legal-hold` endpoint; report C left untouched
  (not yet expired).
- The retention job run for real (`RetentionLifecycleJobService` directly
  instantiated with real `pg.Pool`/`S3ReportStorageService` dependencies
  against the real Postgres/MinIO - not through the running app's own
  `@Cron` schedule, which fires at 3am and can't be triggered on demand
  without a manual-trigger endpoint this phase deliberately didn't add).
- **Confirmed correct**: report A's row is genuinely gone (`GET` → 404;
  a superuser `psql` count query independently confirms `0`, not just an
  RLS-hidden row) and its MinIO object is genuinely deleted (`mc ls`
  before/after). Report B (legal-held) and report C (not expired) both
  survived, in both Postgres and MinIO. A second sweep immediately after
  the first was a clean no-op (idempotent - no errors, no changes).
- A real, disclosed local-environment quirk noted but not chased further:
  this machine's MinIO instance uses a filesystem-backed storage driver on
  case-insensitive-but-case-preserving APFS, which silently folded a
  later lowercase-keyed upload into an earlier uppercase-keyed directory
  entry created before the tenant-id fix - a host/filesystem artifact
  (same "host quirk, not a platform default change" category as the
  macOS AirPlay-port issue noted in earlier phases), not a defect in the
  application code: every actual S3-protocol operation (`PutObject`/
  `GetObject`/`DeleteObject`) used the DB's correctly-lowercased key
  throughout and behaved correctly.
- All test data deleted afterward (via a superuser `DELETE`, plus the
  MinIO bucket removed); both processes killed and ports confirmed free;
  the one-off verification script (`scratch-run-retention-job.ts`)
  deleted, confirmed absent from `git status`.
- Full suites re-run clean: Module 08 188 unit tests (up from 166: 18 new
  this phase plus 4 for the tenant-id fix), typecheck/lint/build clean;
  root's monorepo-wide `npm test` 118 suites/658 tests passing.

## Explicit assumptions (spec was ambiguous or silent here)
1. **One seeded jurisdiction (`US`, 3 years), not a legal database** - a
   deliberate, disclosed minimum given §5b's own "needs periodic legal
   review" framing.
2. **`legal_hold` has no audit trail** - who placed/removed a hold, or
   why, is not recorded anywhere. A real, disclosed gap (this service
   already has `AuditGrpcClientService` wired in since Phase 5 and could
   record this the same way Phase 5's flagged-activation event does; this
   phase does not add that call).
3. **The lifecycle job is a genuine hard delete, no archive tier** -
   matches ADR-0096's own explicit framing, not a new design choice.
4. **No manual-trigger endpoint for the retention sweep** - real
   verification used a standalone script instantiating the job's
   dependencies directly rather than adding an operational escape hatch
   that wasn't otherwise needed.

## Out of scope for this phase (do not build yet)
- Real, comprehensive `RetentionPolicy` coverage across jurisdictions -
  one seeded row plus Phase 6's disclosed fallback for everything else.
- An audit trail for legal-hold changes.
- A reaper/retry mechanism for a report that fails mid-delete beyond the
  next day's tick naturally retrying it (already sufficient given the
  S3-then-Postgres ordering's own safety property).
- Fixing the tenant-id case-sensitivity bug in any other service - found
  and fixed in Module 08 only, disclosed as likely present elsewhere.
- Module 08's own §8 non-goal (RBAC) - `legal_hold` remains as
  unauthenticated/unauthorized as every other write path in this service.
