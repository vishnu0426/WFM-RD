# ADR-0096: `compliance_report` retention is a legal-hold-guarded row-level delete, not a partitioned drop

## Context
§1's datastore row says "PostgreSQL, partitioned by period/jurisdiction
where retention (§5b) demands it" - read literally, an invitation to apply
Module 05's own ADR-0066 precedent (partition `adherence_event` by range,
drop whole old partitions cheaply instead of row-by-row deletion) to this
module's own long-retention table, `compliance_report`. §5b, though, adds a
requirement ADR-0066's source table never had: **`legal_hold` must block
the lifecycle job from acting on an individual row regardless of
`retention_expires_at`.** A legal hold is inherently row-grained - a
regulator export sitting mid-litigation and an unrelated report generated
the same month cannot both be captured by "drop the 2019 partition."
Partition-drop is only cheap when *everything* in the partition is safe to
discard together; a legal hold makes that assumption false for any
partition that happens to contain a held row, which forces the lifecycle
job to fall back to row-level deletion inside that partition anyway - at
which point the partitioning bought nothing for exactly the rows it most
needs to protect.

## Decision
`compliance_report` is **not partitioned** in this migration. The
retention/lifecycle job (§5b, Phase 7) is a scheduled row-level `DELETE ...
WHERE retention_expires_at < now() AND NOT legal_hold` (or an archive-then-
delete variant, per whichever S3-archival design Phase 7 settles on),
backed by the partial index this migration already creates:

```sql
CREATE INDEX idx_compliance_report_retention_expires_unheld
ON compliance.compliance_report (retention_expires_at) WHERE NOT legal_hold;
```

`agno_compliance_app` is granted `DELETE` on `compliance_report` alone - the
one exception to this platform's otherwise-universal "no DELETE" convention
(ADR-0073/0083 restated for this schema in ADR-0093) - because this is the
one table in this module's domain with a real, intentional row deletion
behind it, not a status-column transition standing in for one.
`AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord` are explicitly *not*
given retention/legal-hold columns in this migration: the source spec's
§2.1 literal field list scopes retention fields to `ComplianceReport` only,
and this module's own framing treats the regulator-facing export as the
artifact multi-year retention law actually targets - a future phase
extending retention semantics to the rollup tables themselves is new scope
requiring its own design work, not something this ADR silently assumes.

## Consequences
- No `PARTITION BY RANGE` clause, no partition-maintenance job, no
  partition-aware index tuning for `compliance_report` - meaningfully less
  operational surface than Module 05's `adherence_event` carries, which is
  the right trade for a table whose row-count growth rate (one row per
  report *request*, not per event) is orders of magnitude lower than an
  event stream's.
- The lifecycle job's `DELETE` is a genuine hard delete once a row clears
  both conditions - §5b's explicit "do not build this to auto-delete
  without a review step for anything that might still be under legal hold"
  is satisfied by the `WHERE NOT legal_hold` guard, not by soft-deleting
  every row (there is no `deleted_at` column; a cleared row is actually
  gone from Postgres, with S3 archival/deletion of `fileUri`'s underlying
  object being Phase 7's paired but separate concern).
- If a future tenant's report volume genuinely outgrows row-level deletion's
  efficiency (e.g. a very large org unit generating dense daily exports for
  years), revisiting partitioning is a new ADR to write against real
  measured load - not a decision to make speculatively now against a table
  that has zero rows in this phase.
- Explicitly infra-vs-application-layer split (§5b, same discipline as
  every prior module's own checklist): this module's application layer owns
  the data model (`retentionExpiresAt`, `legalHold`), the computed-at-
  generation-time expiry, and the legal-hold override logic. Actual S3
  object lifecycle policies and backup retention remain genuine
  infrastructure/ops work, not something this ADR or this module's code
  builds.
