# ADR-0005: `audit_log` partitioned by `created_at` (monthly RANGE)

## Context
`audit_log` is append-only and, by construction, the highest-write-volume table in
the module (every mutating action across every downstream module writes here via
`AuditService.RecordEvent` from Phase 5 onward). §0.5 requires capacity planning with
real numbers, not "auto-scale it" — an unbounded single table makes vacuum, index
maintenance, and eventual archival/retention (`policy_type = data_retention`, §2.1)
all get slower in lockstep with total row count forever.

## Decision
`audit_log` is declared `PARTITION BY RANGE (created_at)`, monthly partitions, created
ahead of time by migration for a rolling window (this migration creates the current
month ± 1). Production partition creation/rotation is **explicitly infra/process
work**, not application code — the recommended tool is the `pg_partman` extension
(automated partition creation + retention-policy-driven detach/drop), called out in
`docs/production-readiness-checklist.md` as a pre-go-live item, not solved here.

RLS is declared once on the parent (`ALTER TABLE core.audit_log ENABLE ROW LEVEL
SECURITY`) — Postgres (11+) propagates RLS to partitions automatically, so partition
rotation can never accidentally create an unprotected partition.

## Consequences
- **Composite primary key**: Postgres requires every unique index on a partitioned
  table to include the partition key, so the PK is `(id, created_at)`, not bare
  `id`. Global uniqueness of `id` is therefore guaranteed by UUIDv4 generation
  (application-layer, effectively-unique-by-construction), not by a database
  constraint — a documented, accepted gap, consistent with how most partitioned-PK
  designs work in Postgres today.
- Any query that doesn't filter on `created_at` (e.g. "give me every audit row for
  `resource_id = X` regardless of when") still works (Postgres partition pruning is
  an optimization, not a correctness requirement) but will scan every partition —
  acceptable for Phase 1; the `GET /v1/audit-log` endpoint (Phase 6) is required to
  accept a date-range filter and should default one when the caller omits it, so
  this stays an optimization in practice too.
- New partitions must exist before rows land in that month, or inserts fail closed
  (no `DEFAULT` partition is created deliberately — a silent catch-all partition
  would quietly hide the "we forgot to provision next month" operational bug).
  Flagged in the runbook as a paging alert, not a silent auto-heal.
