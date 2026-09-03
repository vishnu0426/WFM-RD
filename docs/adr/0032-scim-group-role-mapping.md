# ADR-0032: SCIM Group maps 1:1 to a tenant-scoped Role; PATCH supports a documented subset

## Context
§5.3 requires `/scim/v2/Groups` per RFC 7644, but §2.1's domain model has no
"Group" entity - only `Role` and the `UserRole` join (with ABAC scoping via
`scope_org_unit_id`). RFC 7644's PATCH grammar (§3.5.2) is also large:
`add`/`remove`/`replace` operations with arbitrarily complex `path`
expressions (filters, sub-attributes, multi-valued attribute selectors).

## Decision
1. **One SCIM Group = one tenant-scoped `Role`** (`is_system_role = false`,
   `tenant_id` non-null). System-global roles (`platform_admin`,
   `tenant_admin`, ...) are never SCIM-visible - `RolesRepository` (backing
   `ScimGroupsService`) only ever reads/writes tenant-scoped rows by
   construction (see that repository's own doc comment).
2. **Group membership = a tenant-wide `UserRole` assignment**
   (`scope_org_unit_id IS NULL`). A SCIM Group has no concept of org-unit
   scoping, so this mapping is deliberately one-directional: creating/
   patching a Group's members only ever creates/removes tenant-wide role
   assignments. Org-unit-*scoped* role assignments (ABAC, §2.1) still exist
   in `user_roles` and are untouched by SCIM - `/scim/v2/Groups` simply
   doesn't surface or manage them.
3. **PATCH subset** (both `ScimUsersService` and `ScimGroupsService`):
   `replace` on `active`/`userName`/`name.givenName`/`name.familyName`
   (Users) and `displayName`/`members` (Groups, plus `add`/`remove` on
   `members`), each either as a pathed operation
   (`{op:"replace", path:"active", value:false}`) or a path-less `replace`
   whose `value` is an object merging several attributes at once (the shape
   Entra ID's SCIM connector prefers for simple updates). An operation
   outside this subset is silently ignored, not rejected - RFC 7644 clients
   are expected to tolerate a service provider treating an unsupported
   attribute path as a no-op.

## Consequences
- A tenant cannot use SCIM to create genuinely new *permissions* - only new
  role *names* with no `role_permissions` bound to them yet (an empty role).
  Binding permissions to a role is Phase 4's RBAC CRUD surface, not built
  here; a SCIM-created group is provisioned but authorization-inert until
  Phase 4 (or a direct DB operation) grants it permissions.
- `ScimGroupsService.delete` deletes the underlying `Role` row outright
  (`ON DELETE CASCADE` on `role_permissions`/`user_roles` from the Phase 1
  migration handles cleanup) - unlike `User` deprovisioning (§2.1: never a
  hard delete, always `status = disabled`), a SCIM Group deletion really is
  destructive. This asymmetry is intentional: a Role with zero remaining
  members and no further use has no compliance/audit reason to be retained
  the way a person's identity record does.
- The full RFC 7644 filter/PATCH grammar (`and`/`or`/`not`, `pr`/`co`/`sw`
  operators, complex-attribute value filters) is not implemented -
  `parseScimFilter` and this ADR's PATCH subset are what every mainstream
  SCIM connector's default provisioning behavior actually sends, not the
  full spec. Flagged in the production readiness checklist.
