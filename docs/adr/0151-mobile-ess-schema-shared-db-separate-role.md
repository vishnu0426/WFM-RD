# ADR-0151: `mobile_ess` is a new schema in the shared `agno_wfm` database, with its own runtime role

## Context

Same answer as ADR-0017/0052/0066/0073/0083/0093/0108/0113/0136, for the
same reasons. Module 11 needs its own durable Postgres presence for
`OfflineActionQueue` (source spec §2.1). Nothing about this table's data
volume or access pattern argues for a separate Postgres instance — a
bounded per-tenant-per-employee queue of offline actions, not a
high-throughput event stream — and every prior module that stood up a new
deployable service reused the same database with a new schema and a new
least-privilege role rather than provisioning new infrastructure.
`attendance-leave-service` (ADR-0073) is the closest analog: standard
CRUD, no partitioning need, no append-only ledger semantics.

## Decision

A new schema, `mobile_ess`, owned by `agno_migrator` (DDL only), and a new
runtime role, `agno_mobile_ess_app`, with `USAGE` on `mobile_ess` alone —
not `core`, `org`, `attendance_leave`, or any other module's schema.
`agno_mobile_ess_app` gets `SELECT, INSERT, UPDATE` on
`offline_action_queue` in the initial migration
(`1700009500000-InitialMobileEssSchema.ts`), no `DELETE` (a row transitions
through `status` — `pending_sync` → `synced`/`failed`/`conflict` — it is
never removed), and no `CREATE` on the schema itself.

`offline_action_queue.id` has no `DEFAULT gen_random_uuid()` — it is always
client-supplied (the mobile app mints it at queue time) and is the table's
real per-action idempotency mechanism (ADR-0152). This is a deliberate
deviation from every other entity in this platform, worth calling out
explicitly rather than leaving implicit in the migration's own comments.

Module 11 talks to Module 06's attendance data exclusively through
attendance-leave-service's own HMAC-signed `POST /v1/attendance/tenants/
:tenantId/clock-events` webhook (ADR-0152) — never by reading or writing
`attendance_leave.*` directly, even for a "just this once" read.
`agno_mobile_ess_app` structurally cannot do so even if application code
tried to: it has no grant on that schema at all.

## Consequences

- `scripts/init-roles.sql` gains `agno_mobile_ess_app`, the `mobile_ess`
  schema (authorized to `agno_migrator`), and the matching `GRANT CONNECT`/
  `GRANT USAGE`/`ALTER ROLE ... SET search_path` lines — additive only, no
  existing role or schema's grants change.
- `OfflineActionQueue` rows are never hard-deleted by this service — a
  retention/archival policy for old `synced`/`conflict` rows, if one is
  ever needed, is a future decision, not decided here.
- If this service's access pattern ever turns out not to fit standard OLTP
  Postgres after all, the same escape hatch every other module has used
  remains available: a narrowly-scoped `agno_migrator`-credentialed pool
  for DDL-only jobs, not a wholesale re-architecture of this decision.
