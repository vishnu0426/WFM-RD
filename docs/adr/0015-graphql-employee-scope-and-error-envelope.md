# ADR-0015: Phase 2's `Employee` GraphQL type is intentionally partial, and error handling is split REST-filter / GraphQL-formatError

## Context
Two smaller, related Phase 2 decisions worth recording together: how much of §3.1's
`Employee` type to build now (`OrgUnit.employees` needs *some* `Employee` GraphQL
type to return), and how `DomainError`s (already thrown throughout Module 01/02's
repository layer) surface over a transport that has no prior convention in this repo.

## Decision: `Employee` type ships without `skills`
§3.1 lists `Employee { skills, ... }`. Building `skills` correctly needs the `Skill`
GraphQL type and a resolver over `EmployeeSkillsRepository` (Phase 1 data layer
exists; the GraphQL surface for it doesn't) - that's named Phase 4 scope (§8), not
Phase 2's. Rather than add a `skills` field that always resolves `[]`, which is
exactly the "no stubs in in-scope code paths" rule this codebase holds to, the field
is simply not on the type yet. `orgUnit`/`manager` *are* included, fully resolved,
since `EmployeesRepository`/`OrgUnitsRepository` already exist from Phase 1 - nothing
about them is deferred work.

## Decision: REST gets an `ExceptionFilter`, GraphQL gets `formatError`
`@Catch(DomainError) DomainErrorFilter` (via `APP_FILTER`) maps `error.code` to an
HTTP status (`STATUS_BY_CODE` lookup table) and a `{ error: { code, message, details
} }` envelope for REST. Nest's global exception filters do not intercept GraphQL
resolver errors through the same pipeline when using the code-first Apollo driver,
so the equivalent GraphQL-side mapping is `formatGraphQLError`, passed as
`formatError` in `GraphQLModule.forRoot`'s Apollo driver config - it unwraps
`error.originalError`, and for a `DomainError` sets `extensions.code`/`extensions.details`
rather than letting Apollo's default formatting swallow them into an opaque
`INTERNAL_SERVER_ERROR`.

Neither of these had a prior implementation to reuse: Module 01 has never had a REST
controller or a GraphQL resolver, so §3.2's "standard error envelope" cross-cutting
requirement has no existing shared code. This ADR's shapes are a first cut, kept
deliberately small (one status table, one format function), so Module 01 can adopt
or hardening them later rather than this module silently becoming the de facto owner
of platform-wide REST/GraphQL error shape.

## Consequences
- `STATUS_BY_CODE` currently covers `TENANT_CONTEXT_MISSING`, `INVALID_TENANT_ID`,
  `TENANT_MISMATCH` (all from Module 01's `TenantContextService`/`TenantScopedRepository`,
  ADR-0002) and `NOT_FOUND` (this module's `OrgUnitNotFoundError`, via the shared
  `NotFoundError` base in `src/common/errors/`). Any new `DomainError` subclass a
  future phase adds needs an entry here (or falls back to `400 Bad Request`) - not
  automatic, and not currently enforced by a lint/test.
- A non-`DomainError` thrown anywhere in a request path is *not* caught by
  `DomainErrorFilter` (it only `@Catch`es `DomainError`) - Nest's default REST error
  handling (a generic 500) and Apollo's default GraphQL error formatting both apply
  unchanged. This is deliberate: turning every unexpected exception into a
  domain-shaped 4xx would hide real bugs behind a misleadingly client-error-shaped
  response.
- `src/common/errors/not-found.error.ts` is now shared, cross-module infrastructure
  (like `DomainError`, `TenantScopedRepository` before it) - any future "no row with
  this id" error in either module should extend it rather than inventing a new code.
