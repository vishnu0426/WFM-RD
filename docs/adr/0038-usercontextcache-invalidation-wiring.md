# ADR-0038: Wiring `UserContextCacheService.invalidate` into the RBAC mutation endpoints

## Context
Phase 2's `UserContextCacheService` (backing `IdentityService.GetUserContext`,
§3.3) shipped with a 60-second TTL as its only real invalidation mechanism
and an `invalidate(tenantId, userId)` method with no caller - its own doc
comment said so explicitly: "no UserRole/RolePermission mutation API exists
yet ... TTL expiry is the only invalidation path that actually fires ...
`invalidate()` exists now so Phase 4's mutations have a call site to wire
into on day one." Phase 4 is that day.

## Decision
`RoleManagementController` (not `RoleManagementService` - see ADR-0037 for
why `AuthModule`'s `UserContextCacheService` isn't reachable from
`IdentityModule` itself) calls `userContextCache.invalidate(tenantId, userId)`
immediately after every mutation that can change a *currently live* user's
effective roles/permissions:
- `assignRole`/`revokeRole` - the directly affected user.
- `bindPermission`/`unbindPermission`/`deleteRole` - every user currently
  holding that role (`RoleManagementService.userIdsWithRole`, queried
  *before* a destructive `deleteRole`/`unbindPermission` so the affected set
  is still knowable afterward).

## Consequences
- A role/permission change now reflects in a user's next `GetUserContext`
  call (and therefore their next-issued access token's `roles`/`permissions`
  claims) immediately, not after up to 60 seconds of TTL staleness - closing
  the gap Phase 2 explicitly flagged rather than leaving it open indefinitely.
- An **already-issued access token**'s claims are still frozen at issuance
  time regardless of this invalidation - revoking a role does not retroactively
  shrink a token's `permissions` array; it only affects what the *next*
  token issued for that user contains. A token's claims are valid for at
  most 12 minutes (§3.4's access token TTL) regardless, so this bounds the
  staleness window for RBAC changes to "at most one still-valid access
  token's remaining lifetime," not "up to 60 seconds" - a materially
  different (longer) number worth being explicit about, not implied away by
  the cache-invalidation fix alone. An operator needing *immediate* access
  revocation for a specific user should pair a role change with
  `RefreshTokenService.revokeAllSessionsForUser` (the same primitive SCIM
  deprovisioning uses, Phase 3, §5.7) to force re-authentication, not rely
  on cache invalidation alone.
- `userIdsWithRole` is a full table scan of that role's `user_roles` rows,
  which is fine at expected role-membership sizes (tens to low hundreds of
  users per role) but would need indexing attention if a tenant ever bound
  a role to a very large fraction of its user base and mutated it frequently
  - not a measured concern today, flagged for awareness.
