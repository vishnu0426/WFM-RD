# Phase 4 Design Doc — RBAC/ABAC Enforcement + Policy Engine API

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 4 — Role/Permission/RolePermission/UserRole management API,
RBAC/ABAC *enforcement* (not just schema — Phase 1 already built that),
Policy CRUD + versioning (`POST /v1/policies`, `GET /v1/policies/{policyId}/history`,
named explicitly in §3.2), `PolicyService.GetActivePolicy` gRPC (§3.3).
Depends on Phase 2's JWT claims (`roles`/`permissions` arrays, §3.4) and
Phase 1's full RBAC/Policy schema already existing.

## Problem

Every phase through Phase 3 issued tokens carrying `roles`/`permissions`
claims and stored `UserRole.scope_org_unit_id` for ABAC scoping, but nothing
anywhere in this repo ever *checked* them. Every `/v1/*` endpoint built so
far (`/v1/identity-providers`, SCIM's machine-token guard, `/v1/org-units`,
...) is either ungated or gated on possession of a valid token, not on
holding a specific permission. Phase 4 is where that enforcement actually
gets built - along with the two REST endpoints (`POST /v1/policies`,
`GET /v1/policies/{policyId}/history`) §3.2 names explicitly but no prior
phase implemented, and the `PolicyService.GetActivePolicy` gRPC contract
§3.3 names for Scheduling's overtime-rule lookups.

## Decision

**RBAC**: `PermissionsGuard` + `@RequirePermissions(...)` reads the JWT's
already-flat `permissions` claim - zero extra database calls, correct for
any "may this caller do this at all" question. **ABAC**: `AbacService` does
a fresh Postgres join (`user_roles` -> `role_permissions` -> `permissions`)
for questions the flat JWT claim can't answer - "does this caller hold this
permission *for this specific org unit*" - exact-match only, not
subtree-aware (ADR-0036's documented shortfall of §3.1's stated example).
See ADR-0035 for why these are two separate primitives, not one.

**Policy CRUD + versioning**: `PolicyManagementService`/`PolicyManagementController`
(`PolicyApiModule`) wrap `PoliciesRepository`'s new `createLineage`/`supersede`
methods - `supersede` atomically closes the current open version and opens
the next one in a single transaction (ADR-0006's versioning model, now with
a real write path instead of just the schema). Writing an org-unit-scoped
policy additionally requires `AbacService.assertPermittedForOrgUnit`.

**`PolicyService.GetActivePolicy` gRPC**: `PolicyGrpcController`
(`src/grpc`) wraps `PoliciesRepository.findActiveAsOf`/`findActiveByTypeAndScope` -
resolves "active as of" an arbitrary timestamp (§3.3's explicit requirement),
not just "currently open."

**RBAC/Permission management API**: `RoleManagementService`/`RoleManagementController`
(`IdentityApiModule`) - role CRUD, permission catalog listing, permission
binding, and user-role assignment (tenant-wide or ABAC-scoped). Every
mutation that can change a live user's effective permissions invalidates
`UserContextCacheService` for the affected user(s) (ADR-0038), closing a
gap Phase 2 explicitly left open for this phase to fill.

**Avoiding a DI cycle**: `AuthModule` already imports both `PolicyModule`
and `IdentityModule` (Phase 2/3). Phase 4's new controllers need both a
feature module's service *and* `AuthModule`'s guards, which would make the
import circular if placed inside `PolicyModule`/`IdentityModule` themselves.
`PolicyApiModule`/`IdentityApiModule` are composition roots that import both
sides, the same pattern `OrgApiModule` (Module 02) already established -
see ADR-0037.

## Blast radius

- No new tables or columns - every entity Phase 4 needs (`Role`, `Permission`,
  `RolePermission`, `UserRole`, `Policy`) was already built in Phase 1. One
  new seed catalog entry (`role` resource) and several new repository
  methods on already-existing repositories.
- Two new composition modules (`PolicyApiModule`, `IdentityApiModule`),
  additive to `AppModule`'s import list.
- One existing endpoint retroactively gated: `TenantIdentityProvidersController`
  (Phase 3) now requires `tenant:read`/`tenant:write` - the specific TODO
  Phase 3's own readiness checklist flagged for this phase. No other
  pre-existing endpoint in this repo (Module 01 or Module 02) is touched -
  see the "Explicit assumptions" section for why that retrofit is
  deliberately out of scope here.
- First gRPC contract failure mode change: `PolicyGrpcController` is new,
  additive to `GrpcModule`'s existing `EmployeeService`/`CalendarService`/
  `IdentityService`.

## Rollback plan

Additive - reverting this phase means removing `PolicyApiModule`/
`IdentityApiModule` from `app.module.ts`, `PolicyGrpcController` from
`GrpcModule`, and the `@UseGuards`/`@RequirePermissions` decorators from
`TenantIdentityProvidersController`. No migration to revert (no schema
changes this phase). Every Phase 1-3 table/repository/endpoint is
unaffected.

## Explicit assumptions (spec was ambiguous or silent here)

1. **ABAC scoping is exact-org-unit-match, not subtree-aware.** §3.1's own
   example ("scoped to their org-unit subtree") implies hierarchy
   awareness; building that without violating the established
   no-cross-module-table-access boundary needs a new Module 02 gRPC
   contract not built this phase. See ADR-0036.
2. **Only `TenantIdentityProvidersController` is retroactively RBAC-gated.**
   `POST /oauth/register`'s bootstrap-token gate is deliberately left as-is
   (it is itself the mechanism for creating the very first client a tenant
   could use to obtain a token, so RBAC-gating it is circular by
   construction). Every other pre-existing `/v1/*` endpoint (Module 01's own
   SCIM/SSO admin surfaces, all of Module 02) is untouched - a deliberate,
   separate piece of work if/when it's prioritized, not a silent side effect
   of "Phase 4 ships RBAC."
3. **`GET /v1/policies/{policyId}/history`'s `{policyId}` is the lineage's
   `policy_group_id`**, not a single version row's `id` - the spec's literal
   path parameter name doesn't disambiguate, and only the lineage key makes
   "history" a meaningful plural response (ADR-0006's own key).
4. **Deleting a `Role` cascades permission bindings and assignments** (`ON
   DELETE CASCADE` on `role_permissions`/`user_roles`, already established
   by the Phase 1 migration) - `RoleManagementController.deleteRole`
   invalidates every affected user's cache first, matching ADR-0038.

## Out of scope for this phase (do not build yet)

- Subtree-aware ABAC (needs a new Module 02 gRPC contract, ADR-0036).
- `AuditService.RecordEvent`/NATS publication of RBAC/policy mutations -
  still Phase 5; nothing in this phase writes to `audit_log`.
- Retrofit RBAC gating onto every pre-existing endpoint across Module 01/02 -
  explicit assumption 2 above.
- GraphQL exposure of any Phase 4 endpoint - still REST-only, consistent
  with every prior phase's admin surfaces pending Phase 6's GraphQL BFF.
