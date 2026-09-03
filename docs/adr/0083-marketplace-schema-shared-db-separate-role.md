# ADR-0083: `marketplace` is a new schema in the shared `agno_wfm` database, with its own runtime role

## Context
Same answer as ADR-0017/0052/0066/0073, for the same reasons. Module 07
needs its own durable Postgres presence for `MarketplacePost`,
`MarketplaceClaim`, `SwapRequest`, `BidOpportunity`, `Bid`, and
`MarketplaceEngagementScore` (§2.1). Nothing about this module's own data
volume or access pattern argues for a separate Postgres instance - its
§0.5 own framing is "moderate complexity, event-driven, real concurrency
risk... not compute-heavy, not ultra-high-throughput," the same class of
module Module 06 (ADR-0073) was. Redis is this module's concurrency
primitive (§1's distributed lock, ADR-0084), not its system of record -
`MarketplacePost`/`MarketplaceClaim`/etc. live in Postgres exactly as §1's
tech-stack table requires.

## Decision
A new schema, `marketplace`, owned by `agno_migrator` (DDL only), and a new
runtime role, `agno_marketplace_app`, with `USAGE` on `marketplace` alone -
not `core`, `org`, `forecasting`, `scheduling`, `intraday`, or
`attendance_leave`. `agno_marketplace_app` gets per-table
`SELECT, INSERT, UPDATE` grants in the initial migration
(`1700001000000-InitialMarketplaceSchema.ts`), no `DELETE` on any table -
every state change this module's domain needs (a post expiring, a claim
being rejected, a bid opportunity closing) is a status-column UPDATE, not a
row deletion, same reasoning ADR-0073 gives for its own five tables.

Cross-schema references (`MarketplacePost.shift_assignment_id` into Module
04's `ShiftAssignment`, `MarketplaceClaim.claimant_employee_id`/
`SwapRequest.initiator_employee_id`/etc. into Module 02's `Employee`) are
plain `uuid` columns, never a SQL `REFERENCES` across schemas - the same
discipline ADR-0052/0073 established: referential correctness for a
cross-module id is a gRPC/REST-contract concern (§4's synchronous gRPC
guardrail validation, ADR-0082), not Postgres's, and
`agno_marketplace_app` structurally cannot read `org.*`/`scheduling.*`
tables even if application code tried to.

## Consequences
- `scripts/init-roles.sql` gains `agno_marketplace_app`, the `marketplace`
  schema (authorized to `agno_migrator`), and the matching `GRANT CONNECT`/
  `GRANT USAGE`/`ALTER ROLE ... SET search_path` lines - additive only, no
  existing role or schema's grants change.
- Module 07 talks to Module 02's employee/skill data and Module 04's
  schedule/constraint data exclusively through their own contracts (gRPC,
  §4/ADR-0082) - never by reading `org.*`/`scheduling.*` tables directly,
  even for a "just this once" read, since the running role has no grant to
  do so.
- `shift-marketplace-service` is this platform's first Node/NestJS service
  with a GraphQL API as its primary external surface (REST elsewhere in
  this platform is either the sole surface, as in Module 05/06, or absent
  entirely) - a separate, non-schema decision, but worth noting here since
  it means this module's own `TypeOrmModule` registration coexists with a
  GraphQL module from Phase 2 onward, unlike every prior TypeORM-based
  service in this platform.
