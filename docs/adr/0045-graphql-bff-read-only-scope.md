# ADR-0045: Phase 6's GraphQL BFF is read-only for Module 01's own domain

## Context
§3.2 names a GraphQL BFF among Phase 6's external API surface, alongside
the REST integration API. Module 02 already established a precedent where
GraphQL exposes both queries *and* mutations for its own domain
(`OrgUnitResolver.createOrgUnit`/`updateOrgUnit`, `EmploymentPolicyResolver.createEmploymentPolicy`).
Module 01's own domain - `Tenant`, `User`, `Role`, `Permission`, `Policy`,
`AuditLogEntry` - is different in one load-bearing way: every mutation
against it already carries side effects entangled with RBAC/ABAC
enforcement, `UserContextCacheService` invalidation (ADR-0038), and audit
instrumentation (ADR-0041/ADR-0044) that live in the REST controllers
(`RoleManagementController`, `PolicyManagementController`,
`TenantManagementController`, `WebhookSubscriptionsController`). Adding
GraphQL mutations that duplicate those side effects risks the two surfaces
drifting apart (a cache invalidation added to the REST path but forgotten
on the GraphQL path is exactly the kind of bug that's invisible until a
stale permission set ships).

## Decision
`PlatformGraphQLModule`'s resolvers (`TenantResolver`, `UserResolver`,
`RoleResolver`, `PolicyResolver`, `AuditLogResolver`) expose **queries
only** - `tenant`/`myTenant`/`tenantChildren`, `me`/`user`/`users` (+
`roles` field resolver), `role`/`roles`/`permissions` (+ `permissions`
field resolver), `policy`/`policyHistory`/`policies`, `auditLog`. Every one
delegates to the same service/repository its REST counterpart already
uses (`RoleManagementService`, `PolicyManagementService`,
`AuditLogRepository.findByTenant`, `TenantsRepository`) - not a second,
parallel data-access path. REST remains the only mutation surface for this
domain. `AccessTokenGuard`/`PermissionsGuard` were made GraphQL-aware
(`GqlExecutionContext`, not `switchToHttp()`) so both surfaces share
identical RBAC enforcement, not two independently-maintained copies.

## Consequences
- No GraphQL mutation exists for creating a tenant, role, policy, or
  webhook subscription - a client that wants to write must call the
  corresponding REST endpoint. This is a real capability gap relative to
  Module 02's GraphQL surface, not an oversight - flagged explicitly in the
  Phase 6 readiness checklist.
- Every query is exactly as safe as its REST equivalent (same guard, same
  permission string, same underlying service) - there is no way for a
  caller to get broader access through GraphQL than REST already grants.
- `me` is the one query with no `@RequirePermissions` - matches
  `GET /webauthn/credentials`'s existing "my own data needs no RBAC check"
  posture (ADR established informally in Phase 3, made explicit here).
- If a future phase adds GraphQL mutations for this domain, the service
  layer already exists to delegate to (`RoleManagementService`,
  `PolicyManagementService`, ...) - the work is wiring a resolver method,
  not building new business logic, since REST already funnels through
  those same services.
