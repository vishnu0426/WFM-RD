# ADR-0049: `TenantContextMiddleware` binds tenant context from a validated JWT when one is present, closing a cross-tenant header-forgery bypass open since Phase 1

## Context
ADR-0014 shipped `TenantContextMiddleware` as an explicit, documented
placeholder: it binds `TenantContextService` from `X-Tenant-Id`/
`X-Actor-Id`/`X-Actor-Type`/`X-Platform-Admin` request headers, trusted
verbatim, with no authentication. That ADR's own consequences section
named the exact follow-up: "Once Module 01 ships real JWT validation, this
middleware's header-reading body must be *replaced*, not layered under, a
claim-based lookup." Module 01 shipped JWT issuance/validation in its own
Phase 2 (`TokenService`, `AccessTokenGuard`) and RBAC enforcement in Phase 4
(`PermissionsGuard`, `@RequirePermissions`) - but nobody ever went back and
did the replacement ADR-0014 called for. By Phase 6, this had become a
real, exploitable gap, not just a theoretical one:

**The bypass.** `AccessTokenGuard`/`PermissionsGuard` run *after*
`TenantContextMiddleware` (Express middleware runs before Nest's request
pipeline). A caller holding a valid access token for tenant A could send
`X-Tenant-Id: <tenant B>` (and `X-Platform-Admin: true`) alongside it. The
middleware bound tenant context from the *header*, not the token. Every
`TenantScopedRepository` call inside the request handler then executed
against tenant B's RLS context. `AccessTokenGuard` validates the token's
signature/expiry/revocation - it doesn't care which tenant issued it.
`PermissionsGuard` checks whether the token's flat `permissions` claim
contains the required `resource:action` string - permission strings are
not themselves tenant-scoped, so a token from tenant A with `role:write`
satisfies the guard on an endpoint now executing against tenant B. Every
Module 01 controller/resolver added from Phase 4 onward
(`RoleManagementController`, `PolicyManagementController`,
`TenantManagementController`, `WebhookSubscriptionsController`,
`AuditLogController`, every `PlatformGraphQLModule` resolver) was affected,
since none of them independently re-derive their own tenant id the way
`OAuthController`/`SsoController`/`ScimUsersController`/`WebAuthnController`
already do (those resolve tenant from `client_id`/`provider.tenantId`/a
SCIM bearer token's own claims, inside the handler, regardless of what the
middleware bound).

## Decision
`TenantContextMiddleware.use()` now checks for `Authorization: Bearer
<token>` first. If present and it verifies (`TokenService.verifyAccessToken`
- signature, `iss`, `aud`, `exp`), tenant context is bound from the token's
own claims: `tenantId = claims.tenant_id`, `actorId = claims.sub`,
`actorType` inferred (`'system'` if `sub` starts with `client:`, `'user'`
otherwise), `isPlatformAdmin = claims.roles.includes('platform_admin')` -
a real role claim inside a signed token (§3.4's `AccessTokenClaims.roles`
already carried role *names*, not just flattened permissions - no new
claim had to be added). Client-supplied `X-Tenant-Id`/`X-Platform-Admin`/
`X-Actor-*` headers are read only when there is no valid Bearer token -
ADR-0014's original placeholder, now scoped down rather than removed.

Deliberately does **not** check revocation (`TokenRevocationService`) in
the middleware - `AccessTokenGuard` already does, independently, and
rejects with 401 before any repository call runs for every endpoint that
actually requires a valid token. Skipping it here avoids a second Redis
round-trip on every single request for a check that's already
authoritative downstream.

## Consequences
- Closes the bypass: a forged `X-Tenant-Id` alongside a valid Bearer token
  is now simply ignored - the JWT's own `tenant_id` wins. Verified by
  `test/unit/tenant-context.middleware.spec.ts`'s first test case, which
  encodes exactly the attack scenario above and asserts the header is
  ignored.
- The remaining exposure is deliberately unchanged and narrow: any request
  with no valid Bearer token still trusts headers - but every endpoint
  that requires one (`AccessTokenGuard`) already rejects such a request
  regardless of what tenant context got bound, before any sensitive
  repository call executes. The only surface still meaningfully exposed is
  Module 02's pre-Phase-4 endpoints, which never had a guard at all and
  are exactly as exposed today as they were before this ADR - not a
  regression, but also not fixed by this change (retrofitting RBAC onto
  Module 02's surface is a separate, deliberate piece of work, same scope
  discipline as every earlier phase's RBAC-retrofit decisions).
- `TokenService.verifyAccessToken` now runs twice per authenticated
  request that reaches a guarded endpoint (once here, once in
  `AccessTokenGuard`) - a minor, accepted perf redundancy, not optimized
  away in this pass (would require `AccessTokenGuard` to trust
  `req.tokenClaims` if already set by the middleware, coupling the two in
  a way judged not worth the complexity for a signature-verification cost
  that's already sub-millisecond).
- SCIM/WebAuthn controllers, which already explicitly re-bind their own
  tenant context inside each handler (`tenantContext.run({tenantId:
  claims.tenant_id}, ...)`), now get a redundant *outer* bind from the same
  middleware using the same claims - harmless (nested `AsyncLocalStorage.run`
  calls simply shadow the outer one for their duration), not a behavior
  change for those controllers.
