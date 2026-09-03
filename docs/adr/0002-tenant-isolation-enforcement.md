# ADR-0002: Tenant isolation — application guard + Postgres RLS, both mandatory

## Context
§2.2 rule 1 requires a missing tenant filter to fail closed, not leak rows, and
requires this be a guard, not a convention. A single layer of defense is a single
point of failure: RLS alone is invisible to a developer who forgets to `SET LOCAL`
the session variable (queries would then hit `current_setting(...)` with no value
set, which we make fail closed — see below — but a bug there is still a full outage
or a leak depending on which way it fails). An application-layer guard alone doesn't
protect against a raw `psql` session, a future service that talks to the DB directly,
or a bug in the guard itself.

## Decision
Two independent layers, both mandatory, neither trusted alone:

1. **`TenantContextService`** (`src/common/tenant/tenant-context.service.ts`) — an
   `AsyncLocalStorage`-backed store holding `{ tenantId, actorId, actorType }` for the
   duration of a request/job. Nothing downstream can read a tenant id that wasn't
   explicitly bound by whatever sits at the top of the call stack (a controller
   guard in later phases; a seed script or test harness directly in Phase 1).
2. **`TenantScopedRepository<T>`** (`src/common/tenant/tenant-scoped.repository.ts`)
   — the only way application code touches a tenant-scoped table. Every method
   (`find`, `findOneOrFail`, `save`, `update`, `softDelete`) calls
   `tenantContext.requireTenantId()` first and throws `TenantContextMissingError`
   (fail closed) if no context is bound. It also opens the underlying query inside
   `withTenantTransaction`, which issues
   `SET LOCAL app.current_tenant_id = <tenantId>` as the first statement of the
   transaction, sourced only from the ALS store — **never** from a client-supplied
   header or column value.
3. **Postgres RLS**, `ENABLE ROW LEVEL SECURITY` (not `FORCE`) on every tenant-scoped
   table. This is the policy in `1700000000000-InitialSchema.ts` that actually blocks
   `agno_app` if it's ever used outside `TenantScopedRepository` (e.g. a future
   engineer writing a raw `dataSource.query(...)` that forgets the guard) — `agno_app`
   is never the table owner, so plain `ENABLE` already applies to it unconditionally.
   `FORCE` was deliberately **not** added: it would also apply RLS to `agno_migrator`
   (the schema owner), and `agno_migrator` legitimately needs to write global/
   cross-tenant rows outside any session's tenant context — seeding system roles
   (`roles.tenant_id IS NULL`), platform-admin tooling, etc. `FORCE` would make that
   impossible (no `INSERT` policy allows `tenant_id IS NULL`, so even the owner would
   be locked out of its own seed data). Since `agno_app` never owns these tables,
   `FORCE` would add zero protection on the role that actually serves traffic while
   breaking the one role that needs elevated access on purpose. If `app.current_tenant_id`
   is unset, `current_setting('app.current_tenant_id', true)` returns `NULL`, and every
   policy's `USING` clause compares `tenant_id = NULL::uuid` which is never `true` —
   so an unset session variable returns zero rows rather than all rows for `agno_app`.
   Fail closed.

## Consequences
- Every tenant-scoped repository must extend `TenantScopedRepository<T>` — enforced
  by a lint rule placeholder noted in the Phase 1 readiness checklist (a real
  custom-eslint-rule is Phase 6+ polish, not blocking Phase 1).
- Performance cost: one extra `SET LOCAL` round-trip per transaction. Negligible
  relative to the query itself; not a measured bottleneck at this phase (no load
  test exists yet — see the Testing section in Phase 1's README).
- `Permission` (global, no `tenant_id`) and system-global `Role`/`RolePermission`
  rows (`tenant_id IS NULL`) are intentionally exempt from the guard — they use a
  plain `Repository<T>`, not `TenantScopedRepository<T>`, because they are not
  tenant data. This exemption is the one deliberate carve-out from rule 1, and it's
  carved out at the type level (a different base class), not by a conditional
  inside the guard.
