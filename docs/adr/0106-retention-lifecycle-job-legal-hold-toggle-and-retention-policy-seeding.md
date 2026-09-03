# ADR-0106: `RetentionLifecycleJobService`, the legal-hold toggle, and a minimal real `RetentionPolicy` seed

## Context
§5b/ADR-0096: `compliance_report`'s retention is a scheduled, row-level
`DELETE ... WHERE retention_expires_at < now() AND NOT legal_hold`, backed
by a partial index this platform has carried since Phase 1 and never used.
Three real gaps needed a decision before any code could be written:

1. **No `RetentionPolicy` row exists anywhere** - Phase 6 added a minimal
   read (tenant-specific → platform-default-by-jurisdiction → a disclosed
   7-year hardcoded fallback) purely to satisfy `retention_expires_at`'s
   `NOT NULL` constraint, but deferred real seeding to this phase.
2. **`legal_hold` has no write path anywhere** - the column exists, the
   lifecycle job's guard clause exists in ADR-0096's own design, but
   nothing in this module lets a caller actually set it. Without a write
   path, the guard is untestable and the column is dead weight from the
   API's perspective - defeating the whole point of the design.
3. **ADR-0096 left the S3-side deletion an open "paired but separate
   concern"** - deleting the Postgres row without deleting (or at least
   deciding what happens to) the underlying S3 object would leave orphaned
   objects accumulating forever, silently defeating the retention
   requirement retention law actually cares about (the artifact itself,
   not just the database pointer to it).

## Decision

**A minimal, real `RetentionPolicy` seed migration**: one platform-default
(`tenant_id: NULL`) row, jurisdiction `US`, `retention_years: 3`. A
deliberately small seed, not a legal database - §5b's own framing
("needs periodic legal review, it isn't a permanent hardcoded fact")
governs this choice directly: seeding many jurisdictions with
confidently-asserted retention periods this session has no authority to
certify would be worse than seeding one, clearly-a-placeholder row and
leaving Phase 6's disclosed 7-year fallback in place for every
unseeded jurisdiction. `retention_years: 3` is chosen as a plausible,
commonly-cited floor for US wage/hour recordkeeping - explicitly a
starting point for real legal review, not asserted as authoritative.

**`legal_hold` gets a real write path**: `PATCH /v1/compliance/reports/{id}/legal-hold`
(`ComplianceReportService.setLegalHold`), the same
`ComplianceReportNotFoundError`/tenant-ownership check `getReport` already
uses. No new authorization model - matches this module's own §8 non-goal
(no RBAC anywhere in Module 08) exactly as every prior phase's write path
already accepted.

**`RetentionLifecycleJobService`**: a new `@Cron` job (this service's
third, after Phase 3's two rollup jobs), same shape -
`MIGRATOR_PG_POOL`-backed (cross-tenant sweep in one tick, the identical
reasoning ADR-0098 already gives for the rollup jobs: RLS's `ENABLE`-not-
`FORCE` posture means only the table owner bypasses per-tenant scoping),
a `ticking` overlap guard, `getNumberConfig`-driven tuning, metrics on
every run. Runs daily (`0 3 * * *`) rather than every 15 minutes -
retention is not latency-sensitive the way adherence rollups are.

For each row where `retention_expires_at < now() AND NOT legal_hold`
(capped at a bounded batch per tick, `RETENTION_LIFECYCLE_BATCH_SIZE`):
deletes the S3 object first (if `file_uri` is set - a `pending`/`failed`
report never got one), then deletes the Postgres row. **Deletion order
matters**: S3 first means a crash between the two steps leaves an orphaned
*Postgres row* (safe - it will be retried next tick, since it is still
past its expiry and still not legal-held) rather than an orphaned *S3
object with no surviving pointer to it* (unrecoverable - nothing would
ever know to clean it up again). A missing S3 object on delete (already
gone, e.g. from a previous partial run) is treated as success, not a
retryable error - `DeleteObjectCommand` is itself idempotent by AWS's own
design.

This is a genuine hard delete, matching ADR-0096's own explicit framing
("there is no `deleted_at` column; a cleared row is actually gone") - no
archive-to-cold-storage tier, since nothing in the module prompt calls for
one and inventing one would be new, unrequested scope.

## Consequences
- A second `MIGRATOR_PG_POOL`/`migratorPoolProvider` registration exists
  in this service now (`ComplianceModule`, alongside `AdherenceModule`'s
  pre-existing one) - a second `pg.Pool` (max 2 connections) to the same
  database, not a shared one. A real, disclosed resource duplication
  (module-boundary separation over sharing one pool across unrelated
  feature areas), not an oversight - the provider's own doc comment is
  updated to track both callers explicitly, per its own "never add a
  third caller without updating this doc comment" instruction.
- A tenant/admin can now toggle `legal_hold` on any of their own reports
  with no restriction and no audit trail - a real, disclosed gap (an
  audit event for "who placed/removed a legal hold and why" is exactly
  the kind of governance signal ADR-0079's `AuditService.RecordEvent` (already
  wired into this service since Phase 5) exists for, but this phase does
  not add that call). Acceptable given §8's own no-RBAC non-goal applies
  equally here; revisit if legal-hold misuse becomes a real operational
  concern.
- `AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` remain untouched by
  any retention/deletion logic, unchanged from ADR-0096's own explicit
  scope boundary - this phase does not extend retention semantics to the
  rollup tables.
- Every jurisdiction other than `US` still falls to Phase 6's disclosed
  7-year hardcoded default - this phase adds real machinery around the
  seed, not comprehensive real-world legal coverage.
