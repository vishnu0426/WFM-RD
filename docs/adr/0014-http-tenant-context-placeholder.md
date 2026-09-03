# ADR-0014: `TenantContextMiddleware` binds tenant context from request headers - an explicit JWT-validation placeholder

## Context
Phase 2 is the first HTTP/GraphQL surface built anywhere in this repo - Module 01
has no controllers/resolvers as of its own Phase 1, and its own Phase 1 design doc
already anticipated this gap: "JWT issuance/validation - the tenant-context guard in
this phase accepts a `tenantId` handed to it by a caller; wiring that caller to a
real validated JWT is Phase 2" (Module 01's Phase 2, not this one - Module 01 has
still not built it). `TenantContextService.run()` (ADR-0002) needs *something* to
call it with a tenant id before any `TenantScopedRepository` call in a request can
succeed, and nothing upstream of this module produces a validated identity yet.

## Decision (revised in Phase 3)
`TenantContextMiddleware` (plain Express middleware, registered via
`AppModule.configure()` for `'*'`, not a Nest `Interceptor`) reads `X-Tenant-Id`,
`X-Actor-Id`, `X-Actor-Type`, and `X-Platform-Admin` off the raw request and calls
`tenantContext.run(...)` around `next()`. If `X-Tenant-Id` is absent, no context is
bound at all - the request proceeds, and the first `TenantScopedRepository` call it
hits fails closed via `TenantContextMissingError` (ADR-0002's existing behavior).

**This was originally shipped as a Nest `Interceptor` (`TenantContextInterceptor`,
`APP_INTERCEPTOR`) and had to be replaced.** Nest only runs `APP_INTERCEPTOR`s around
a *root handler* invocation - a `@Query`/`@Mutation` method, or a REST controller
method. `@ResolveField` resolvers for nested GraphQL fields are invoked directly by
graphql-js's own executor as it walks the response tree, and empirically do **not**
re-enter Nest's interceptor pipeline. Under the interceptor version,
`employee(id) { id }` bound tenant context correctly, but `employee(id) { orgUnit {
id } }` did not - the nested `orgUnit` field resolver saw no bound context at all and
failed closed with `TenantContextMissingError`, on a request whose top-level query
had a perfectly valid `X-Tenant-Id`. Since almost every non-trivial query in this
module's schema (`OrgUnit.children`, `OrgUnit.employees`, `Employee.orgUnit`,
`Employee.manager`, `Employee.directReports`, ...) is a `@ResolveField`, this wasn't
an edge case - it broke the majority of realistic queries.

Express middleware fixes this structurally rather than by chasing each broken field:
it runs once, at the very top of the Express pipeline, before Nest (and therefore
before GraphQL) does anything. `tenantContext.run(...)` wraps the synchronous call to
`next()`, and Express's downstream dispatch is a direct, synchronous call chain from
that point - `AsyncLocalStorage` correctly follows every async continuation causally
descended from it, including graphql-js's internal nested-field scheduling, no matter
how many promise/microtask hops deep that scheduling goes. This is the standard,
textbook-correct place to bind `AsyncLocalStorage` in an Express-based app.

This is explicitly not authentication or authorization. A client can send any
`X-Tenant-Id` it wants and read/write within that tenant, gated only by whatever a
network operator puts in front of this service. It is safe *only* because nothing
in this codebase is deployed to serve real traffic yet.

## Consequences
- `X-Platform-Admin: true` is trusted verbatim from the header - a placeholder that
  is unsafe by construction (ADR-0007's whole point was that this flag must only
  ever come from a validated `platform_admin` role claim). Flagged with a `TODO`
  at the point of use and in the production readiness checklist, not silently
  shipped as if it were the real mechanism.
- `§3.1`'s ABAC requirement ("a Site Supervisor's `employees` query is implicitly
  scoped to their `org_unit_id` subtree via `UserRole.scope_org_unit_id`") is **not**
  implemented by this middleware or anywhere else in this module - it requires
  RBAC/ABAC evaluation logic that doesn't exist yet (explicitly Module 01's own
  Phase 4, per its Phase 1 design doc's own out-of-scope list). Tenant isolation only
  (via `TenantContextService` + Postgres RLS); sub-tenant, role-scoped authorization
  is a gap this ADR records rather than papers over.
- Once Module 01 ships real JWT validation, this middleware's header-reading body
  must be *replaced*, not layered under, a claim-based lookup - the header names
  chosen here (`X-Tenant-Id` etc.) have no contractual meaning beyond this
  placeholder and should not be treated as a stable API surface by any external
  client.
- Any future cross-cutting concern that needs to see *every* GraphQL field
  resolution, not just root handlers, should default to Express middleware first and
  only reach for a Nest interceptor once it's confirmed the concern only needs
  root-handler-level coverage - this ADR's revision is the concrete cautionary case.
