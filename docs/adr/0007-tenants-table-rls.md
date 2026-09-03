# ADR-0007: `core.tenants` is RLS-protected (self + BPO children + platform-admin)

## Context
Phase 1 originally shipped `core.tenants` with no RLS at all, reasoning that
resolving "which tenant is this session" would require reading `tenants`
first, making RLS on that table circular. That reasoning doesn't hold up:
`app.current_tenant_id` is sourced from the validated JWT's `tenant_id`
claim (§3.4's exact claim shape), not from a lookup against `tenants` - the
claim is already resolved and signed by the time a request reaches this
module. There is no ordering problem, and leaving the tenant-identity table
itself with no row-level protection was a real gap: without it, a bug
anywhere upstream of the (not-yet-built) tenant-scoping middleware could
expose every tenant's name, tier, and BPO hierarchy to every other tenant.

`tenants` still can't use the same policy shape as every other table,
though - it has no `tenant_id` column (its own `id` **is** the tenant
identity), and two access patterns don't fit "row belongs to my tenant":
BPO parents need visibility into their child tenants, and platform-admin
tooling (`POST /v1/tenants`, cross-tenant support/ops) needs to operate
across every tenant, not just one.

## Decision
Two session GUCs, both set the same way (from validated identity, in the
same transaction-scoped `set_config(..., true)` call as `app.current_tenant_id`,
never from client-supplied input):

- `app.current_tenant_id` (existing, used everywhere).
- `app.is_platform_admin` (new) - `'true'`/unset, set only when the resolved
  identity holds the `platform_admin` system role. Compared as
  `current_setting('app.is_platform_admin', true) = 'true'` so an unset
  session variable evaluates to `false`, not an error - fail closed, same
  posture as every other policy in this schema.

Policies on `core.tenants`:
- **SELECT**: `is_platform_admin OR id = current_tenant_id OR parent_tenant_id
  = current_tenant_id` - a tenant sees itself and its direct BPO children;
  a platform admin sees everything.
- **INSERT**: `is_platform_admin OR parent_tenant_id = current_tenant_id` - a
  tenant may onboard a child tenant under itself (BPO multi-client
  onboarding); only a platform admin may create a new top-level tenant
  (`parent_tenant_id IS NULL`).
- **UPDATE**: same predicate as SELECT, both `USING` and `WITH CHECK` - a
  tenant may update itself or a direct child it owns.
- **No DELETE policy**: `agno_app` has no `DELETE` grant on `tenants` at all
  (tenants are soft-deprovisioned via `status`, never row-deleted), so there
  is nothing for a DELETE policy to gate.

Platform-admin sessions still bind a `current_tenant_id` (e.g. a dedicated
platform-operations tenant, or whichever tenant the admin is currently
acting on behalf of) - `is_platform_admin` is strictly additive, not a
replacement for the tenant binding every other table's RLS depends on.

## Consequences
- `TenantContextStore` gained an optional `isPlatformAdmin` flag, and
  `withTenantTransaction` now sets both GUCs every transaction (harmless
  `set_config('app.is_platform_admin', 'false', true)` when absent, so an
  unset flag is indistinguishable from an explicit `false` inside the
  transaction).
- Only BPO parent → direct child visibility is modeled (one level), matching
  §2.2 rule 5's "arbitrary depth" requirement at the schema level (the
  self-referencing FK supports any depth) while keeping the Phase 1 RLS
  policy simple. A BPO admin wanting to see grandchildren goes through
  application-layer traversal (walk `parent_tenant_id` one hop at a time,
  each hop a session the caller is authorized for), not a recursive RLS
  policy - recursive RLS predicates are a well-known performance and
  correctness hazard in Postgres and are deliberately avoided here.
- `is_platform_admin` cannot itself be validated by this module alone - it
  is only as trustworthy as whatever sets it (Phase 2's JWT validation
  reading a `platform_admin` role claim). Phase 1 provides the DB-side
  contract; Phase 2 is responsible for only ever setting this flag from a
  cryptographically validated token, never a client-supplied header.
