# Module 08 Phase 1 Design Doc — Adherence & Compliance: Schema & Migrations

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08), with a
Compliance/Legal-liaison Architect role specifically for this module (§0) -
`ComplianceRule.citation` and the rule-change impact preview exist because
enterprise legal teams need to trust this module's output, not just because
it's good engineering practice, and that framing shapes several of this
phase's schema decisions below.
**Scope:** The full §2.1 entity set — `AdherenceScore`, `OccupancyRecord`,
`ShrinkageRecord`, `ComplianceRule`, `ComplianceReport` — plus the two
closing-a-flagged-gap additions the module prompt requires from day one,
not retrofitted later: `RuleChangeImpactPreview` (§5a) and the
`RetentionPolicy` concept plus `ComplianceReport.retentionExpiresAt`/
`legalHold` (§5b). One migration, in a new standalone deployable,
`adherence-compliance-service/` (Node/NestJS), plus the minimal service
skeleton needed to run and verify that migration: `compliance` schema/
`agno_compliance_app` role (ADR-0093), TypeORM data-source/runtime config,
and the platform's standard `/healthz`/`/readyz`/`/metrics` +
tenant-context + domain-error-filter scaffold. **No rollup job, no
ComplianceRule CRUD, no gRPC/REST client or server, no report generation,
no retention lifecycle job, no GraphQL, no NATS.** Those are Phases 2–8 per
§7's own build-phase list. This phase does not call Module 02/04/05 over
any transport — every cross-module id (`employeeId`, `orgUnitId`,
`orgUnitScope`) is a bare, unvalidated `uuid` column, and the tenant-context
middleware is the same header-trust placeholder every prior module's Phase
1 started with (ADR-0014).

## Problem

Module 08 is framed (§0, §0.6) as the platform's single source of truth for
labor-law thresholds and as a compliance-critical reporting module (§0.5) —
higher governance stakes than most modules' schema work, even though the
actual Phase 1 deliverable (tables + migration + skeleton) looks
superficially identical to every prior module's Phase 1. Four decisions are
worth pinning now, in schema shape, rather than left for the phase that
first needs them:

1. **§1's explicitly-flagged rollup-source ADR.** The source spec's
   architecture section still describes consuming "Module 05's Kafka
   adherence event stream" / a "ClickHouse event stream," both stale
   relative to Module 05's actual (already-overridden) NATS/Postgres
   design. §1 requires picking, explicitly, between a direct Postgres read
   against Module 05's rollup tables and NATS JetStream consumption of the
   raw event stream — see ADR-0094. This doesn't change this phase's own
   migration shape, but it is a real architectural commitment this module
   owns and needed to be decided before Phase 3 could be scoped, not
   discovered mid-implementation.
2. **§2.2 rule 3's nullable-`tenantId` platform-default shape**, required
   for `ComplianceRule` and, by the same reasoning, `RetentionPolicy` (§5b).
   Applied naively, this platform's uniform `tenant_isolation` RLS policy
   would silently hide every platform-default row from every tenant. Getting
   the RLS policy shape right now — rather than discovering the bug once
   Phase 2's CRUD tries to read a seeded platform default and gets nothing
   back — avoids a policy rewrite later. See ADR-0095, which also flags (as
   an open question for Phase 2, not this phase's to solve) *who* is
   authorized to write a platform-default row in the first place.
3. **§5b's retention/partitioning tension.** §1's datastore row reads as an
   invitation to partition `compliance_report` the way Module 05 partitions
   `adherence_event` (ADR-0066). §5b's `legal_hold` requirement is
   row-grained by nature and undermines the efficiency argument for
   partition-drop the moment any partition contains a held row. Decided now
   as row-level delete + a partial index, not partitioning — see ADR-0096.
4. **This module owns the same schema/role decision every prior service
   that stood up new Postgres presence has made** (shared database, new
   schema, new role) — settled, not novel, but still needs its own ADR per
   this platform's convention of one ADR per service's Phase 1 for this
   exact decision (ADR-0017/0052/0066/0073/0083 precedent). See ADR-0093.

Beyond those four, this phase follows the precedent every prior module's
Phase 1 set for standing up a new deployable service: reuse the platform's
existing conventions (RLS via `app.current_tenant_id`, `varchar` + `CHECK`
enums per ADR-0003, tenant-id-first indexes, the two-role migrator/app
split, OTel/prom-client/health scaffolding) rather than inventing parallel
ones.

## Decision

A new standalone deployable, `adherence-compliance-service/` (Node/NestJS),
sibling to `attendance-leave-service/`/`shift-marketplace-service/` rather
than a module folded into root `src/` or `intraday-service/` — consistent
with how Modules 03–07 were each stood up independently. Runs outside
`docker-compose.yml` against the already-provisioned Postgres container,
same as every other service — no new infrastructure container needed this
phase.

**Schema** (`src/database/migrations/1700003000000-InitialComplianceSchema.ts`):
one migration, all seven tables, in the new `compliance` schema.
Tenant-id-first composite indexes on every table, RLS `ENABLE` on all seven
(ADR-0002), `varchar` + `CHECK` for every enum-shaped column (ADR-0003).
Five tables (`adherence_score`, `occupancy_record`, `shrinkage_record`,
`compliance_report`, `rule_change_impact_preview`) use the platform's
ordinary uniform `tenant_isolation` policy; `compliance_rule` and
`retention_policy` use the split `USING (... OR tenant_id IS NULL) / WITH
CHECK (...)` policy ADR-0095 designs. `agno_compliance_app` gets `SELECT,
INSERT, UPDATE` everywhere except `compliance_report`, which additionally
gets `DELETE` for ADR-0096's legal-hold-guarded lifecycle job; no `CREATE`
on the schema anywhere.

Constraints worth calling out specifically:
- `compliance_rule_citation_required_check` — `btrim(citation) <> ''` —
  makes §2.2 rule 2's "mandatory, not optional" citation requirement
  structurally impossible to violate at the database layer, the same class
  of guarantee ADR-0054/attendance-leave's backdated-reason check used.
- The two partial unique indexes on `compliance_rule` (platform-default
  version uniqueness, tenant-scoped version uniqueness) exist because a
  single composite `UNIQUE` constraint would never actually catch two
  colliding platform-default rows — `NULL != NULL` in a unique index. Same
  reasoning applied to `retention_policy`.
- `adherence_score_upsert_key`/`occupancy_record_upsert_key`/
  `shrinkage_record_upsert_key` — the exact `ON CONFLICT` targets §2.2 rule
  4's idempotent/resumable rollup-job requirement depends on; getting these
  right now is this phase's version of attendance-leave's `LeaveBalance`
  composite-PK decision (schema shape decided ahead of the phase that
  enforces it).
- `compliance_report_retention_expires_at`'s `NOT NULL` and
  `idx_compliance_report_retention_expires_unheld`'s `WHERE NOT legal_hold`
  partial index are the schema-level guarantees ADR-0096's lifecycle job
  (Phase 7) is designed around.

**Entities** (`src/adherence/entities/`, `src/compliance/entities/`):
TypeORM classes mirroring the migration's DDL exactly, one per table, each
with a TS `enum` backing its `varchar`+`CHECK` columns (ADR-0003's stated
split). These exist for query-building in later phases — nothing in this
phase's request path (there isn't one) touches them yet.

**Service skeleton**: `TenantContextService`/`Middleware`/`Module` (own
copy, header-trust placeholder, ADR-0014's convention), `HealthController`
(`/healthz` always-200 liveness, `/readyz` Postgres-fatal readiness — no
Redis-shaped live-state cache to give an asymmetric posture to in this
phase), `MetricsService`/`Controller`/`Module` (prom-client, `/metrics`),
`DomainError`/`DomainErrorFilter` (typed error envelope). `MetricsService`
also declares `compliance_rollup_job_lag_seconds`/
`compliance_rollup_job_runs_total` (§0.5's rollup SLO) and
`compliance_validate_policy_against_floor_calls_total`/
`compliance_impact_preview_flagged_but_activated_total` (§6's two governance
metrics) now, undocumented by any real call site until Phase 3/4/5 wire
them — declared early so those phases inherit a settled metric name/bucket
convention instead of inventing one under phase pressure.

Observability: `observability/prometheus.yml` gains a sixth Node-service
scrape target (`agno-wfm-adherence-compliance-service`, port 8500) —
additive, matching every existing Node service entry's shape.

## Blast radius

- Entirely new directory (`adherence-compliance-service/`) plus two new docs
  and four new ADRs — zero modification to any Module 01–07 table,
  migration, schema, or running code path.
- Additive edits to two shared files: `scripts/init-roles.sql` gains the
  `agno_compliance_app` role and `compliance` schema block (every existing
  role/schema line untouched); `observability/prometheus.yml` gains one new
  scrape job (every existing job untouched).
- No `docker-compose.yml` change — runs as a local process against the
  already-running Postgres container, same posture as every other service.
- No cross-service call of any kind — nothing in this phase depends on
  Module 01/02/04/05's running code, and nothing in those services depends
  on this one yet. In particular, the §0.6 Module 02/04 reconciliation work
  this module exists to enable — `PolicyService.GetActivePolicy`'s merge
  logic, `EmploymentPolicy`'s write-time `ValidatePolicyAgainstFloor` gate —
  is entirely unbuilt; this phase only lays the schema `GetActiveRule`/
  `ValidatePolicyAgainstFloor` will eventually read from (Phase 4).

## Rollback plan

Delete `adherence-compliance-service/`, revert the additive blocks in
`scripts/init-roles.sql` and `observability/prometheus.yml`, drop the
`compliance` schema (`DROP SCHEMA IF EXISTS compliance CASCADE;` — the
migration's own `down()`), remove the two new docs and four new ADRs.
Nothing external references this schema or service yet, so rollback is a
non-event now — this stops being true once Phase 2+ puts real rule-CRUD
traffic and, eventually, Module 02/04's own runtime dependency behind it.

Same platform-wide `migration:revert`-to-zero CLI gap every prior module's
Phase 1 design doc has already documented (dropping a schema's first
migration's own tracking table out from under TypeORM's subsequent
bookkeeping) applies identically here — not re-litigated per module; read
this phase's rollback plan as "drop the schema directly."

Verified against a real local Postgres instance (not just unit tests):
`migration:run` executes cleanly end to end against the already-provisioned
`agno_wfm` database, the built app boots and serves `/healthz`/`/readyz`/
`/metrics` using the least-privilege `agno_compliance_app` role, RLS
actually blocks a cross-tenant read on `adherence_score` (an insert bound to
one tenant is invisible to a session bound to a different tenant, and
visible again to the original tenant), the citation `CHECK` actually
rejects a `compliance_rule` insert with an empty citation, and ADR-0095's
split RLS policy behaves exactly as designed both directions: a tenant
session cannot insert a `NULL`-tenant `compliance_rule` row (rejected by
`WITH CHECK`), but can read a platform-default row seeded by the schema
owner (`agno_migrator`, which bypasses RLS as the table owner since this
migration does not set `FORCE ROW LEVEL SECURITY`).

## Explicit assumptions (spec was ambiguous or silent here)

1. **Service directory/schema/role name is `adherence-compliance-service` /
   `compliance` / `agno_compliance_app`**, not `compliance-service` or
   `adherence-service`. The module's own document title is "Adherence &
   Compliance," covering two related but distinct sub-domains (operational
   metrics: `AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord`; legal
   rules: `ComplianceRule`/`ComplianceReport`/etc.) — mirroring
   attendance-leave-service's own precedent of using the full two-noun name
   rather than a shorter one that would undersell half the module's real
   scope. The **schema** name is the shorter `compliance` alone (not
   `adherence_compliance`), following `shift-marketplace-service`'s own
   precedent of a concise schema name (`marketplace`, not
   `shift_marketplace`) and matching every REST path (`/v1/compliance/...`)
   and gRPC service name (`ComplianceRuleService`) the module prompt's own
   API contracts already use.
2. **`ComplianceReport` gains a `status` column** (`pending`/`completed`/
   `failed`) not present in §2.1's literal field list. `generateComplianceReport`/
   `POST /v1/compliance/reports` (§3.2) is explicitly async and returns a
   `job_id`; without a status column there is no way to represent "accepted,
   file not ready" distinctly from "generation failed." Added now, in this
   migration, for the same "not retrofitted" reasoning the module prompt
   applies to `RuleChangeImpactPreview`/`RetentionPolicy` themselves.
3. **`RuleChangeImpactPreview` and `RetentionPolicy` both get a plain
   `tenant_id` column** even though neither is in §2.1's literal field list
   and §5a/§5b's own field lists for them don't mention one either. Every
   table in this platform is RLS-scoped by convention (ADR-0002) — a preview
   row is already scoped by `complianceRuleId`, but the platform's
   structural RLS invariant requires the column regardless, the same
   reasoning attendance-leave's `LeaveBalance` added a plain `tenant_id`
   column outside its composite PK.
4. **Who is authorized to write a platform-default `ComplianceRule`/
   `RetentionPolicy` row is deliberately left unanswered by this phase's
   schema**, not accidentally omitted. ADR-0095 designs the RLS policy so a
   normal tenant connection can read but never write a `NULL`-tenant row;
   Phase 2 must make an explicit decision (a platform-admin write path, or
   out-of-band seeding) rather than this migration guessing at an
   authorization model that doesn't exist yet anywhere in this platform.
5. **No partitioning on any table in this migration**, despite §1's
   datastore row reading as an invitation to partition by "period/
   jurisdiction where retention demands it." ADR-0096 explains why
   `compliance_report`'s row-grained `legal_hold` requirement makes
   partition-drop the wrong tool for this table specifically, and why the
   other six tables (rollup data, not long-retention legal artifacts) have
   no retention-driven partitioning need stated anywhere in the module
   prompt to begin with.
6. **The rollup job will read Module 05's Postgres rollup tables directly**
   (ADR-0094), not consume NATS JetStream — confirmed as this phase's
   architectural commitment even though no code in this phase implements
   either option. `.env.example` accordingly declares `INTRADAY_DB_*`
   placeholders (unused until Phase 3) rather than `NATS_URL`.

## Out of scope for this phase (do not build yet)

- The rollup job runner reading Module 05's Postgres rollup tables and
  populating `AdherenceScore`/`OccupancyRecord`/`ShrinkageRecord`, and the
  §0.5 reproducibility test ("same report requested twice returns identical
  numbers") that exercises it — Phase 3.
- `createComplianceRule`/`activateComplianceRule`, citation enforcement at
  the application layer, and the platform-admin-vs-tenant-override
  authorization decision ADR-0095 flags — Phase 2.
- `ComplianceRuleService.GetActiveRule`/`ValidatePolicyAgainstFloor` gRPC
  surface, and the actual Module 02 `EmploymentPolicy` write-path /
  Module 04 `PolicyService.GetActivePolicy` merge-logic reconciliation work
  §0.6 requires — Phase 4. This module's data existing is a precondition for
  that work, not the work itself.
- `RuleChangeImpactPreview`'s real simulation logic (re-running the
  constraint check against published schedules) and the `AuditLog` entry
  for "activated despite flagged non-compliance" — Phase 5.
- Async `generateComplianceReport`, all four report types, S3 export — Phase
  6.
- The retention/lifecycle `@Cron` job, `RetentionPolicy` seeding, and the
  legal-hold-guarded delete ADR-0096 designs the schema around — Phase 7.
- GraphQL surface (`adherenceScores`, `occupancyTrend`, `shrinkageBreakdown`,
  `complianceRules`, all mutations). Not built at all in this phase.
- Dashboards/runbooks, the §6 governance metrics actually being populated by
  real traffic — Phase 8.
