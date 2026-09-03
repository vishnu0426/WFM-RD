# Module 02 Phase 2 Design Doc — Org Structure + Temporal Queries

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §8 Phase 2 — `OrgUnit` CRUD, subtree queries, `asOfDate` resolution,
GraphQL/REST surface for org hierarchy. Depends on Phase 1's schema/repositories
(`OrgUnitsRepository`, `OrgUnitHistoryRepository`, `EmployeesRepository`) being
already applied and tested.

## Problem

Phase 1 built a complete, tested data layer for org structure with no way to reach
it over the network - no controllers, no resolvers, nothing in this repo (Module 01
included) had ever mounted an HTTP or GraphQL route before this phase. Phase 2 needs
to expose `OrgUnit` CRUD and both the current and as-of-a-past-date org hierarchy
(§2.3's named enterprise requirement: backdated payroll disputes, compliance audits)
without a real authentication/authorization layer to build on top of yet, since
Module 01 has not shipped one.

## Decision

NestJS controllers/resolvers over the mandated stack (§1: GraphQL/Apollo external,
REST for the one integration-shaped endpoint §3.2 names for org hierarchy). A new
composition module, `OrgApiModule`, owns the resolvers/controller that need to see
across the `OrgUnitModule`/`EmployeeModule` boundary (`OrgUnit.employees`,
`Employee.orgUnit`/`manager`) so those two Phase 1 data-layer modules don't have to
import each other (see `OrgApiModule`'s own doc comment). `OrgHierarchyService` is
the single implementation of "current vs. as-of" branching, shared by the GraphQL
`orgHierarchy` query and the REST tree endpoint (ADR-0013).

Since nothing upstream produces a validated tenant identity yet, a global
`TenantContextMiddleware` binds `TenantContextService` from request headers -
explicitly flagged as a placeholder (ADR-0014), the same posture Module 01's own
Phase 1 design doc took toward the same gap.

## Blast radius

- First HTTP/GraphQL surface in the whole repo. `main.ts` now actually mounts
  routes; previously it bootstrapped the Nest app with nothing listening beyond the
  bare port.
- No breaking change to Phase 1's schema or repositories - this phase is additive
  (new resolvers/controllers/services on top of existing, already-tested
  repositories).
- New runtime dependencies: `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`,
  `graphql`, `class-validator`, `class-transformer` (input validation for GraphQL
  `InputType`s and, going forward, REST DTOs).

## Rollback plan

Additive - reverting this phase means removing `OrgApiModule`/`GraphQLModule`
registration from `app.module.ts` and the global interceptor/filter/pipe from
`main.ts`; the Phase 1 schema and repositories are untouched and keep working
exactly as their own tests already prove.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`createOrgUnit`/`updateOrgUnit` mutation names and shape.** §3.1's mutation
   list (`createEmployee`, `updateEmployeeSkills`, `transferEmployee`,
   `createEmploymentPolicy`) names no OrgUnit mutation at all, even though §8 Phase 2
   explicitly requires "OrgUnit CRUD." Added `createOrgUnit`/`updateOrgUnit` (one
   update mutation covers rename, reparent, and archive - see
   `UpdateOrgUnitInput`'s own doc comment for why a single mutation was chosen over
   three narrower ones).
2. **`orgHierarchy(rootId, asOfDate)` reconstructs past trees via an in-memory walk
   over `OrgUnitHistory`, not a recursive SQL CTE.** See ADR-0013.
3. **Tenant context over HTTP/GraphQL is bound from request headers, not a validated
   JWT.** See ADR-0014 - there is no JWT validation anywhere in this repo yet.
4. **`Employee` GraphQL type ships without a `skills` field.** See ADR-0015 - that
   needs the `Skill` GraphQL surface, which is Phase 4 scope.
5. **§3.1's ABAC requirement (Site Supervisor scoped to their org-unit subtree) is
   not implemented.** It depends on RBAC/ABAC evaluation logic that doesn't exist in
   Module 01 yet (its own Phase 4). Phase 2 enforces tenant isolation only.
6. **REST is GET-only in this phase** (`GET /v1/org-units/{id}/tree`) - `OrgUnit`
   create/update are GraphQL-only mutations, matching the mandated stack's own
   framing of REST as reserved for bulk/integration operations (§1), not general CRUD.

## Out of scope for this phase (do not build yet)

- Employee/Skill/Calendar/EmploymentPolicy GraphQL or REST surfaces (Phases 3-5).
- Real JWT validation / RBAC-ABAC evaluation (Module 01's own later phases).
- Bulk HRIS import, gRPC contracts, NATS eventing (Phases 6-7).
- Rate limiting, `Idempotency-Key` handling, and the rest of §3.2's cross-cutting
  REST requirements beyond the one endpoint this phase actually ships - there is
  exactly one REST route in this phase, and building out infrastructure for
  requirements it doesn't yet exercise (bulk-import's idempotency keys, for
  instance) would be speculative.
