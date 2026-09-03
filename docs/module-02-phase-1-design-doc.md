# Module 02 Phase 1 Design Doc — Org & Employee Schema & Migrations

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §2 entities (`OrgUnit`, `Employee`, `Skill`, `EmployeeSkill`,
`WorkingTimeCalendar`, `EmploymentPolicy`, `OrgUnitHistory`, `EmployeeHistory`,
`ErasureRequest`), RLS, partitioning, indexes, seed data for local dev — no
GraphQL/REST/gRPC/event surface yet (those are Phases 2, 6, 7) and no nightly decay
job (Phase 4). Depends on Module 01's `core` schema being already applied.

## Problem

Module 02 needs a persistence layer that: (a) inherits Module 01's tenant-isolation
guarantees unchanged (same `TenantScopedRepository`/RLS discipline, no
reimplementation), (b) serves Scheduling's `GetSchedulableEmployees` hot path
(§0.5 SLO: p99 < 100ms) at a stated 10M+ employee-record platform-wide scale, and
(c) builds the two pieces of infrastructure the source spec explicitly flags as
"needs explicit design, not a later retrofit" - SCD Type 2 history (§2.3) and the
GDPR erasure mechanism (§2.4) - into the schema from day one rather than
retrofitting them once real data exists.

## Decision

TypeORM + hand-written SQL migrations, extending the exact pattern Module 01
established in ADR-0001 - no new tooling decision needed here. A new `org` Postgres
schema, owned by the same `agno_migrator`/`agno_app` two-role split as `core`
(ADR-0007's precedent), with its own migration
(`1700000001000-Module02OrgEmployeeSchema.ts`) that also makes one additive,
in-place extension to Module 01's `core.policies` table (ADR-0012).

Four new Nest modules mirror §6's internal module boundaries - `OrgUnitModule`,
`EmployeeModule` (which also owns `ErasureRequest`), `SkillModule`,
`CalendarModule` - plus one new repository (`EmploymentPoliciesRepository`) added
to Module 01's existing `PolicyModule` rather than a new module of its own.

## Blast radius

- Additive to an existing, already-running-locally schema. `org.*` tables are
  entirely new; the one change to `core.policies` (a nullable column + a widened
  CHECK constraint) is backward compatible with every existing Module 01 row and
  query. Zero behavior change for any Module 01 code path that doesn't reference
  `orgUnitId` or the four new `PolicyType` values.
- Still no deployed service - this phase produces schema/entities/repositories
  only, same as Module 01 Phase 1.

## Rollback plan

Every migration statement has a corresponding `down()` step, including reverting
`core.policies`' CHECK constraint and dropping the added column, before dropping
the entire `org` schema. As with Module 01 Phase 1, nothing external depends on
this schema yet, so rollback is a non-event now - this matters starting Phase 2+.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Materialized path (`ltree`) for `OrgUnit`, not a bare recursive CTE.** See
   ADR-0008. Driven by the §0.5 SLO on `GetSchedulableEmployees`, which filters by
   org-unit subtree.
2. **Two typed SCD Type 2 tables (`OrgUnitHistory`, `EmployeeHistory`), trigger-written.**
   See ADR-0009. Chosen over one generic `temporal_snapshot` table (typed columns
   serve the compliance/backdated-dispute query shape §2.3 names far better than a
   `jsonb` blob) and over an application-layer write (a DB trigger can't be
   bypassed by an application bug, which matters more here than unit-testability).
3. **`Employee`/`EmployeeHistory`/`EmployeeSkill` are `PARTITION BY HASH (tenant_id)`,
   8-way, fixed at creation.** See ADR-0010. Chosen over RANGE/LIST-by-tenant
   because this platform's tenant distribution doesn't have the "few whale tenants"
   shape RANGE partitioning wants, and HASH needs no `AuditLog`-style partition
   rotation job.
4. **`ErasureRequest` ships as schema + lifecycle repository only in this phase -
   no anonymization logic.** See ADR-0011. §2.4 requires the table to exist now;
   §8 scopes the actual field-by-field anonymization workflow to Phase 8.
5. **`EmploymentPolicy` is not a new table.** See ADR-0012. `core.policies` gains a
   nullable `org_unit_id` column and four new `policy_type` values instead of a
   parallel `org.employment_policies` table, per §2.2 rule 5's explicit instruction
   to reuse, not duplicate, Module 01's policy engine.
6. **Composite FKs, not trigger-synced columns, enforce cross-entity tenant
   consistency.** `Employee.orgUnitId`/`managerEmployeeId`/`userId` and
   `EmployeeSkill.skillId` all use composite FKs against a `(tenant_id, id)` unique
   constraint on the referenced table (following `Employee`/`user_roles`'
   `uq_users_tenant_id_id` precedent from Module 01), rather than the
   trigger-sync approach ADR-0004 used for `role_permissions`. A composite FK is
   possible here because none of the referenced-side tenant columns are nullable
   the way `roles.tenant_id` is - the trigger workaround ADR-0004 needed doesn't
   apply.
7. **`WorkingTimeCalendar`/`Skill`/`ErasureRequest` gained `created_at`/`updated_at`
   (or `requested_at`) timestamps** even where §2.1's literal field list omits
   them (`Skill`, `ErasureRequest.requestedAt` doubles as its creation timestamp),
   matching every other entity in both modules and standard operability practice
   (knowing when a row was created/changed).

## Out of scope for this phase (do not build yet)

- Any HTTP/GraphQL/gRPC surface (Phases 2, 6, 7).
- The nightly decay/certification-alert job (Phase 4) - `EmployeeSkill.decayScore`
  exists with its `[0,1]` CHECK constraint and a `1` default, but nothing
  recomputes it yet.
- NATS JetStream publishing for `EmployeeChanged`/`SkillExpiring` (Phase 6).
- The GDPR erasure anonymization workflow itself (Phase 8) - only the request
  lifecycle mechanism ships now (ADR-0011).
- Bulk HRIS import (Phase 6).
- `EmploymentPolicy` evaluation logic beyond the schema (Phase 5, wired into
  `PolicyService.GetActivePolicy`).
