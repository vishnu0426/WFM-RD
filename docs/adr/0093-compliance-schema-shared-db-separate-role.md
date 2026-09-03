# ADR-0093: `compliance` is a new schema in the shared `agno_wfm` database, with its own runtime role

## Context
Same answer as ADR-0017/0052/0066/0073/0083, for the same reasons. Module 08
needs its own durable Postgres presence for `AdherenceScore`,
`OccupancyRecord`, `ShrinkageRecord`, `ComplianceRule`, `ComplianceReport`,
`RuleChangeImpactPreview`, and `RetentionPolicy` (§2.1, §5a, §5b). This
module's own §1 tech-stack table is explicit that the datastore is
PostgreSQL, not ClickHouse, and every prior module that stood up a new
deployable service reused the same database with a new schema and a new
least-privilege role rather than provisioning new infrastructure.

## Decision
A new schema, `compliance`, owned by `agno_migrator` (DDL only), and a new
runtime role, `agno_compliance_app`, with `USAGE` on `compliance` alone -
not `core`, `org`, `forecasting`, `scheduling`, `intraday`,
`attendance_leave`, or `marketplace`. `agno_compliance_app` gets per-table
`SELECT, INSERT, UPDATE` grants in the initial migration
(`1700003000000-InitialComplianceSchema.ts`), with one deliberate exception:
`compliance_report` additionally gets `DELETE`, the one table in this
module's domain with a real, scheduled row-level delete behind it (§5b's
retention/lifecycle job, guarded by `legal_hold` - see ADR-0096). No table
gets `CREATE` on the schema itself.

Cross-schema references (`OccupancyRecord.orgUnitId`/`ShrinkageRecord.orgUnitId`
into Module 02's org-unit hierarchy, `AdherenceScore.employeeId` into Module
02's employee data, `ComplianceReport.orgUnitScope` likewise) are plain
`uuid` columns, never a SQL `REFERENCES` across schemas - same discipline
ADR-0052/0073/0083 established: referential correctness for a cross-module
id is a gRPC/REST-contract concern, not Postgres's, and
`agno_compliance_app` structurally cannot read `org.*`/`scheduling.*` tables
even if application code tried to. This module's one genuinely new
cross-schema wrinkle - reading Module 05's `intraday.*` rollup tables for
the rollup job (§1, ADR-0094) - does **not** get a grant on `intraday` for
`agno_compliance_app` either; that read uses a dedicated connection
authenticated as `agno_intraday_app` (see ADR-0094), not a widened grant on
this module's own runtime role.

## Consequences
- `scripts/init-roles.sql` gains `agno_compliance_app`, the `compliance`
  schema (authorized to `agno_migrator`), and the matching `GRANT CONNECT`/
  `GRANT USAGE`/`ALTER ROLE ... SET search_path` lines - additive only, no
  existing role or schema's grants change.
- Module 08 talks to Module 02's org/employee data and Module 04's
  schedule/policy data exclusively through their own contracts (gRPC/REST,
  §3.3) - never by reading `org.*`/`scheduling.*` tables directly, even for
  a "just this once" read, since the running role has no grant to do so.
  Conversely, Module 02's `EmploymentPolicy` write path and Module 04's
  `PolicyService.GetActivePolicy` read this module's `ComplianceRule` data
  exclusively through `ComplianceRuleService`'s gRPC contract (§0.6, §3.3) -
  never by reading `compliance.*` tables directly.
- If this module's write volume or access pattern ever turns out not to fit
  standard OLTP Postgres after all, the same escape hatch every other module
  has used remains available: a narrowly-scoped `agno_migrator`-credentialed
  pool for DDL-only/cross-tenant jobs (`migrator-pool.provider.ts`'s
  pattern, ADR-0066), not a wholesale re-architecture of this decision.
