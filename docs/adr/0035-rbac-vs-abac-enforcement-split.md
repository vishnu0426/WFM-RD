# ADR-0035: RBAC enforcement reads the JWT; ABAC enforcement requires a fresh Postgres lookup

## Context
§4 asks for both RBAC ("does the caller hold this permission at all") and
ABAC ("... for this specific org-unit-scoped resource," §3.1's named
example: "Site Supervisor scoped to their org-unit subtree"). §3.4's JWT
`permissions` claim is a flat `["resource:action", ...]` array, aggregated
across *every* role assignment a user holds regardless of that
assignment's `scope_org_unit_id` (`UserContextResolverService`, Phase 2) -
by design, since the mandated claim shape has no room to carry per-
permission scope information. That flat array is sufficient for RBAC but
provably insufficient for ABAC: a user whose only grant of `policy:write`
comes from a role scoped to org unit X would still show `policy:write` in
their token unconditionally, with no way to tell from the token alone
whether a specific policy write (for org unit Y) should be allowed.

## Decision
Two independent enforcement primitives, not one:
1. **`PermissionsGuard`** (RBAC) - checks `request.tokenClaims.permissions`
   against `@RequirePermissions(...)`. Zero database calls; as cheap as
   token verification itself. Sufficient and correct for any endpoint whose
   authorization question is "may this caller perform this action at all,"
   with no per-instance scoping (e.g. `/v1/roles`, `/v1/identity-providers`).
2. **`AbacService`** (ABAC) - a fresh, per-request Postgres query joining
   `user_roles` -> `role_permissions` -> `permissions`, filtered to rows
   where `scope_org_unit_id IS NULL` (tenant-wide) OR `= targetOrgUnitId`
   (exact match - see ADR-0036 for why not subtree-aware). Used by
   `PolicyManagementService` before writing an org-unit-scoped `Policy` row.
   Never cached - unlike RBAC's JWT claim (which is only as fresh as the
   12-minute access token), an ABAC decision must reflect the current
   `user_roles` state, since staleness here directly changes which specific
   resource instance a write would touch.

## Consequences
- `PermissionsGuard` alone is not a correctness guarantee for any endpoint
  that writes to or reads a resource carrying its own `orgUnitId` - every
  such endpoint must also call `AbacService`, and forgetting to do so is an
  application-code review responsibility, not something the guard itself
  can catch (it has no way to know an endpoint's business resource is
  ABAC-scoped from the route alone).
- ABAC checks cost a real query per call, unlike RBAC's already-loaded JWT
  claim - acceptable for the write-path endpoints that need it (policy
  creation/versioning is not a hot path), but not something to reach for on
  every read of a high-frequency endpoint without considering the cost.
- This split is why `PolicyManagementController`'s `@RequirePermissions('policy:write')`
  and `PolicyManagementService.createOrVersion`'s `AbacService.assertPermittedForOrgUnit`
  call are both present and both necessary - the guard rejects a caller with
  no `policy:write` grant anywhere before the service is even invoked; the
  service rejects a caller who holds `policy:write` only for a different org
  unit than the one being written.
