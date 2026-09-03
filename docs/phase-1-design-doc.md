# Phase 1 Design Doc — Schema & Migrations

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §2 entities, RLS, indexes, seed data for local dev — no API/event surface yet (those are Phases 2–6).

## Problem

Module 01 needs a persistence layer that is safe by construction for a multi-tenant,
identity-critical system: a single missing `WHERE tenant_id = ...` must never leak a
row across tenants, `AuditLog` must be tamper-evident, and the schema must support
verticals (banking/healthcare/retail) with different business rules without forking
the codebase.

## Options considered

1. **Prisma** — excellent DX and migration diffing, but RLS + `SET LOCAL` inside the
   same transaction as a query requires Prisma's interactive transactions API, and
   grant/trigger/partitioning DDL still has to be hand-written raw SQL either way
   (Prisma's schema DSL cannot express `GRANT`, `CREATE POLICY`, or partitioned
   tables). No compounding benefit over TypeORM once we accept hand-written SQL.
2. **Drizzle** — good raw-SQL ergonomics, but the NestJS integration story and
   repository-pattern ecosystem is thinner, and this pod needs a request-scoped
   repository base class (see ADR-0002) that maps cleanly onto TypeORM's
   `Repository<T>` extension points.
3. **TypeORM** (chosen) — first-class NestJS integration (`@nestjs/typeorm`),
   migrations are plain SQL wrapped in a TS class (`up`/`down`), and the
   `Repository<T>` class is designed to be subclassed, which is exactly the shape
   ADR-0002's tenant guard needs. See ADR-0001.

## Decision

TypeORM with hand-written SQL migrations (no schema auto-sync, ever — `synchronize`
is hard-disabled even in dev, see `src/database/data-source.ts`). Tenant isolation is
enforced twice — a NestJS-layer repository guard that refuses to run without a bound
tenant context (ADR-0002), and Postgres RLS as defense-in-depth (§2.2 rule 1). Two DB
roles (`agno_migrator`, `agno_app`) so `AuditLog` immutability (§2.2 rule 2) is a GRANT
fact, not an application promise.

## Blast radius

- New repo, new database (`agno_wfm`), nothing else depends on this yet. Zero
  production blast radius — this phase produces no deployed service.
- Local dev only requires Docker (Postgres 16) via `docker-compose.yml`.

## Rollback plan

Every migration has a matching `down()`. `npm run migration:revert` reverts the last
batch. Because nothing external depends on this schema yet, rollback is a non-event
in Phase 1 — this matters starting Phase 2+ once real data exists (see the
backward-compatibility rules in §0.5, which this doc doesn't need to invoke yet).

## Explicit assumptions (spec was ambiguous here)

1. **`role_permissions`, `user_roles`, `notification_preferences` get a denormalized
   `tenant_id` column** even though §2.1's literal field list omits it. Rule 1
   ("`tenant_id` first column in every composite index, on every tenant-scoped
   table, no exceptions") and fast RLS both require it — an `EXISTS` subquery
   through `roles`/`users` to derive tenant from a join table is both a well-known
   RLS performance trap (subplans re-run per row, don't use the index they're
   filtering on) and a correctness trap during login-time context resolution. See
   ADR-0004.
2. **`Policy` needs a lineage key.** `GET /v1/policies/{policyId}/history` (§3.2,
   Phase 6) implies one logical policy has many version rows. §2.1 doesn't name that
   grouping column, so this phase adds `policy_group_id` (self-referencing on the
   first version) plus `UNIQUE (tenant_id, policy_group_id, version)`. See ADR-0006.
3. **`AuditLog` is partitioned by `created_at` (monthly, RANGE).** Not required by
   §2.1's field list, but required by §0.5's capacity-planning and cost guardrails
   given this table is by far the highest-write-volume table in the module. See
   ADR-0005 for the composite-PK consequence this creates.
4. **Enums are `varchar` + `CHECK`, not native Postgres `ENUM` types.** See
   ADR-0003 — native enums are painful to extend and this module explicitly needs
   to add e.g. new `policy_type` values per vertical without a blocking migration.

## Out of scope for this phase (do not build yet)

- Any HTTP/GraphQL/gRPC surface (Phases 2, 6).
- JWT issuance/validation — the tenant-context guard in this phase accepts a
  `tenantId` handed to it by a caller; wiring that caller to a real validated JWT is
  Phase 2.
- NATS outbox publishing for `AuditEvent`/`PolicyChanged` (Phase 5).
- SSO/SCIM/WebAuthn (Phase 3), RBAC/ABAC evaluation logic beyond the schema (Phase 4).
