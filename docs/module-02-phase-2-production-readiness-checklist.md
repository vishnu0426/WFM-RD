# Module 02 Phase 2 Production Readiness Checklist

Extends `docs/module-02-production-readiness-checklist.md` (Phase 1) rather than
restating it - this covers what Phase 2's GraphQL/REST surface adds.

## Delivered in this phase (application code)

- [x] GraphQL (code-first, Apollo driver): `orgUnit(id)`, `orgHierarchy(rootId,
      asOfDate)` queries; `createOrgUnit`, `updateOrgUnit` mutations; `OrgUnit`
      type with `parent`/`children`/`employees` field resolvers; a scoped
      `Employee` type (`orgUnit`/`manager` resolved, `skills` deliberately not
      yet - ADR-0015).
- [x] REST: `GET /v1/org-units/{id}/tree?as_of=<date>`, sharing
      `OrgHierarchyService` with the GraphQL `orgHierarchy` query (ADR-0013).
- [x] `TenantContextMiddleware` binds every request (REST and GraphQL) to
      `TenantContextService`, explicitly flagged as a placeholder pending real
      JWT validation (ADR-0014) - fails closed (no fabricated tenant id) when
      `X-Tenant-Id` is absent.
- [x] `DomainErrorFilter` (REST) + `formatGraphQLError` (GraphQL) give every
      `DomainError` thrown anywhere in the repository/service layers a stable,
      transport-appropriate shape instead of an opaque 500/`INTERNAL_SERVER_ERROR`
      (ADR-0015).
- [x] Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`)
      rejects malformed/unexpected input at the edge, backed by `class-validator`
      decorators on `CreateOrgUnitInput`/`UpdateOrgUnitInput`.
- [x] `OrgApiModule` composition boundary keeps `OrgUnitModule`/`EmployeeModule`
      free of a circular dependency on each other.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **Real authentication/authorization.** `TenantContextMiddleware` trusts
      client-supplied headers, including `X-Platform-Admin` (ADR-0014). This is
      the single largest gap in this phase - nothing here should be exposed to
      real traffic until Module 01 ships JWT validation and this middleware is
      replaced, not extended.
- [ ] **ABAC / org-unit-scoped authorization** (§3.1's Site Supervisor example).
      Depends on RBAC/ABAC evaluation logic that doesn't exist in Module 01 yet.
      Every query in this phase is tenant-scoped only.
- [ ] **Rate limiting, `Idempotency-Key` handling, `X-Request-Id` propagation**
      (§3.2's cross-cutting REST requirements) - not built for the one REST route
      this phase ships (a GET has no idempotency concern; rate limiting is
      platform/gateway-level infra, not application code).
- [ ] **GraphQL query complexity/depth limiting.** `orgHierarchy` and the
      `parent`/`children` field resolvers on `OrgUnit` can in principle be used to
      construct a deep/expensive query against a large org tree; no complexity
      analysis or depth limit is configured on the Apollo driver yet.
- [ ] **N+1 query mitigation (DataLoader).** `OrgUnitResolver.resolveChildren`/
      `resolveEmployees` and `EmployeeResolver.resolveOrgUnit`/`resolveManager`
      each issue one query per parent object resolved - fine for `orgUnit(id)`
      (a single object), a real cost for a query that resolves many `OrgUnit`s'
      `children`/`employees` in one request. Flagged, not fixed, in this phase.
- [ ] **Load testing of `orgHierarchy`/the REST tree endpoint** against the
      10M-employee/large-org-tree capacity targets (§0.5) - ADR-0013 states the
      reasoning for the in-memory-walk design but it is not empirically validated.
- [ ] **API documentation** (GraphQL schema is self-documenting via introspection
      at `src/schema.gql`, generated at build/boot time; no OpenAPI/Swagger spec
      exists yet for the REST route).

## Environment note: `.env`'s `DB_USERNAME` and what it does to the RLS test suites

This environment's `.env` intentionally sets `DB_USERNAME=postgres` (the Postgres
superuser) for both the running application and test runs, rather than `agno_app`
(the restricted runtime role `scripts/init-roles.sql` provisions). That is a valid
choice for local convenience, but it has one specific, unavoidable consequence: the
six tests in `test/integration/rls-isolation.spec.ts` and
`test/integration/org-rls-isolation.spec.ts` that assert RLS/grant *denial*
("Postgres RLS holds even if the application guard is bypassed", "`agno_app`
cannot write ... at the grant level," etc.) will fail under this `.env` - not from a
code defect, but because Postgres exempts superusers from Row Level Security and
GRANT/REVOKE checks entirely, by design. Those specific assertions are only
meaningful when the raw connection they open is genuinely `agno_app`.
`test/integration/org-api-http.spec.ts` (Phase 2) is unaffected - it verifies the
application-layer `TenantScopedRepository` guard, which filters by `tenantId`
explicitly and holds regardless of DB role. To exercise the RLS/grant tests
meaningfully, run them with `DB_USERNAME=agno_app DB_PASSWORD=<agno_app's password>`
for that one test invocation, without changing `.env` itself.
