# ADR-0037: `PolicyApiModule`/`IdentityApiModule` as composition roots, avoiding an AuthModule<->PolicyModule/IdentityModule cycle

## Context
Phase 4's new controllers (`PolicyManagementController`, `RoleManagementController`)
need both a feature module's service (`PolicyModule`'s `PolicyManagementService`,
`IdentityModule`'s `RoleManagementService`) and `AuthModule`'s RBAC primitives
(`AccessTokenGuard`, `PermissionsGuard`, and `UserContextCacheService` for
cache invalidation). `AuthModule` already imports both `PolicyModule`
(`AuthMethodPolicyService`, Phase 3) and `IdentityModule`
(`UsersRepository`/`PasswordAuthService`/etc., Phase 2) - so either of
those modules importing `AuthModule` back to reach its guards would be a
circular module dependency.

## Decision
`PolicyApiModule` and `IdentityApiModule` (`src/modules/policy-api.module.ts`,
`src/modules/identity-api.module.ts`) each import both sides and own
exactly the one controller that needs to see across the boundary - the
identical shape Module 02's `OrgApiModule` already established for its own
version of this problem (`OrgUnitModule`/`EmployeeModule` needing to see
each other's data without importing each other - see that module's own doc
comment). `PolicyModule` and `IdentityModule` themselves stay exactly as
clean as they were before this phase; `AuthModule`'s existing imports of
both are unchanged.

## Consequences
- A third small module per cross-boundary controller is more files than a
  `forwardRef()` would need, but keeps every module's dependency graph a
  strict DAG, readable from its own file without tracing a runtime-resolved
  cycle - the same trade-off `OrgApiModule` already made and this phase
  simply follows.
- Any future controller needing both a feature module's service and
  `AuthModule`'s guards should default to this pattern (a small composition
  module) rather than reaching for `forwardRef()` - consistent with
  `OrgApiModule`'s precedent being now three-for-three across this codebase.
- `AuthModule` remains the one module every other Module 01 feature module
  is comfortable depending on directly (already true since Phase 2); it is
  not expected to ever need to import a feature module it doesn't already
  depend on (`IdentityModule`, `PolicyModule`) specifically to reach a
  controller - controllers belong in composition modules, not `AuthModule`
  itself, past this point.
