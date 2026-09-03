# ADR-0017: `forecasting` schema in the shared `agno_wfm` database, served by a new `agno_forecasting_app` role

## Context
Module 03 is a separate deployable process in a separate language. Two questions
follow: does it get its own Postgres database (matching "separate service" at the
infrastructure level), and does it authenticate as the existing `agno_app` role
or a new one.

## Options considered
1. **Separate database entirely.** Cleanest process-level isolation, but doubles
   the connection-pooling/backup/PITR/credential-rotation surface (§0.5's
   capacity-planning discipline applies to ops surface, not just compute) for no
   isolation benefit RLS doesn't already provide within one database, and makes
   §3.2's `forecastModelProvenance` query and any future cross-module join
   (e.g. Scheduling reading `required_headcount` directly rather than through an
   event) structurally harder for a benefit that doesn't materialize until this
   platform is at a scale where per-service database sharding is being considered
   as a deliberate scaling decision, not a Phase 1 default.
2. **Same database, new schema, reuse `agno_app`** (rejected), **or reuse
   `agno_app`'s credential for a Python service.** Rejected on two grounds: (a) it
   couples two independently-deployed services' credential-rotation lifecycles
   together for no benefit, and (b) it means a Python-service bug with a raw,
   unguarded query would run with every grant `agno_app` has ever accumulated
   across `core`/`org`/`forecasting`, which is a strictly worse blast radius than
   a role scoped to just what this service touches.
3. **Same database, new schema, new role** (chosen).

## Decision
`forecasting` schema in the existing `agno_wfm` database, `AUTHORIZATION
agno_migrator` (same migrator role, same as `core`/`org`). Runtime queries use a
**new** `agno_forecasting_app` role, granted `USAGE` on `forecasting` only (not
`core`, not `org` — this service does not read Module 02's tables directly per
§5/§8's explicit gRPC-contract boundary) and table-level grants per-table in the
migration itself, following the same "exceptions are explicit and reviewable in
the migration file, not a blanket GRANT" pattern `scripts/init-roles.sql`
documents for `agno_app`.

## Consequences
- `scripts/init-roles.sql` gains one new role and one new schema grant block;
  zero changes to `agno_migrator`'s or `agno_app`'s existing grants.
- Tenant isolation reuses Module 01's exact mechanism (ADR-0002): `forecasting.*`
  tables get `ENABLE ROW LEVEL SECURITY` (not `FORCE`, same rationale — the
  migrator role legitimately needs cross-tenant access for schema/seed work,
  `agno_forecasting_app` never owns these tables so plain `ENABLE` already binds
  it), policies keyed on `current_setting('app.current_tenant_id', true)::uuid`,
  the identical GUC name Module 01 chose — a deliberate reuse, not a coincidence,
  so a future cross-service Postgres session (e.g. a debugging `psql` session, or
  a future service that legitimately needs to read across schemas) has exactly
  one tenant-context convention to reason about, not two different GUC names for
  the same concept.
- If this platform later does move to per-service databases as a deliberate
  scaling decision, this ADR's schema-not-database choice is the thing that gets
  revisited — nothing in the RLS/GUC design is database-count-dependent, so that
  migration (should it ever happen) is a `pg_dump`/connection-string change, not
  a tenant-isolation redesign.
