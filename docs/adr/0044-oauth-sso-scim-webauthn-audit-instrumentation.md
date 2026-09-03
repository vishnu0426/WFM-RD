# ADR-0044: audit instrumentation extended to OAuth/SSO/SCIM/WebAuthn, and `AuditModule` split to keep the DI graph acyclic

## Context
ADR-0041 deliberately scoped Phase 5's audit instrumentation to two
representative write paths (Policy CRUD, RBAC mutations), explicitly
naming what it left undone: "No audit trail exists yet for: OAuth token
issuance/revocation, SSO logins, SCIM user/group provisioning and
deprovisioning, WebAuthn credential registration,
`TenantIdentityProvidersController`'s IdP config changes." The production
readiness checklist repeated the same gap as an open item. This ADR closes
it.

Closing it required solving a DI problem ADR-0041 didn't have to face:
`AuditModule` (as of Phase 5) imported `AuthModule` so `AuditLogController`
could use its guards. Every module this ADR needed to instrument -
`AuthModule` itself (`OAuthController`), `SsoModule`, `ScimModule`,
`WebAuthnModule` - either *is* `AuthModule` or already imports it. Having
any of them import `AuditModule` back would create a cycle
(`AuthModule` → `AuditModule` → `AuthModule`).

## Decision
**Split `AuditModule`.** The lightweight `AuditModule` (`AuditLogRepository`,
`PendingAuditEventsRepository`, `AuditEventBatcherService`) no longer
imports `AuthModule` at all - it depends on nothing except
`CoreEventingModule`. `AuditLogController` (the one piece that genuinely
needs `AuthModule`'s guards) moved into a new composition-root module,
`AuditApiModule` (`imports: [AuditModule, AuthModule]`), the same pattern
`PolicyApiModule`/`IdentityApiModule` already established (ADR-0037) -
applied here for the first time in the *opposite* direction (a leaf module
being imported by the thing that used to import it, rather than a new
controller module bridging two existing ones).

With that cycle broken, `AuthModule`, `SsoModule`, `ScimModule`, and
`WebAuthnModule` each now import `AuditModule` directly and record audit
events:

- **`OAuthController`** (`AuthModule`): `oauth_token.issued` (authorization_code
  and client_credentials grants), `oauth_token.refreshed`,
  `oauth_token.revoked`, `oauth_client.registered` - via
  `AuditEventBatcherService.enqueue` (fire-and-forget), not
  `AuditLogRepository.record` directly, because these are this module's
  highest-volume, most latency-sensitive endpoints - the same reasoning
  §3.3's batching design already exists for.
- **`SsoController`** (`SsoModule`): `sso_login.succeeded` on a completed
  federated login (after JIT provisioning/linking), via
  `AuditEventBatcherService` - login-initiation
  (`GET .../login/:tenantIdpId`) is deliberately not audited, to avoid
  double-counting an ephemeral pending-request row that may never
  complete.
- **`TenantIdentityProvidersController`** (`SsoModule`): `tenant_identity_provider.created`/
  `.updated`/`.deleted`, via synchronous `AuditLogRepository.record` - the
  same admin-CRUD pattern `RoleManagementController`/`PolicyManagementController`
  already use (low-volume, high-consequence, already-authenticated admin
  actions, not a hot path).
- **`ScimUsersController`/`ScimGroupsController`** (`ScimModule`):
  `scim_user.created`/`.replaced`/`.patched`/`.deactivated` and
  `scim_group.created`/`.replaced`/`.patched`/`.deleted`, via
  `AuditEventBatcherService`, `actor_type = system` (the caller is an
  external IdP's SCIM connector authenticated via a `client_credentials`
  token, not an interactive user - see `ScimAuthGuard`'s own doc comment).
- **`WebAuthnController`** (`WebAuthnModule`): `webauthn_credential.registered`,
  `webauthn_credential.deleted`, `webauthn_authentication.succeeded`, via
  `AuditEventBatcherService`. `WebAuthnService.verifyAuthentication`'s
  return type changed from a bare `string` (the session token) to
  `{ token, userId }` so the controller has an actor id to audit with -
  its only caller (`WebAuthnController.authenticateVerify`) was updated in
  the same change.

Every new action string follows ADR-0041's `<resource>.<verb>` convention
(`oauth_token.issued`, `scim_user.created`, ...), extended with a
`<resource>.<verb>_<outcome>` variant where the event is intrinsically
about an outcome rather than a CRUD verb (`sso_login.succeeded`,
`webauthn_authentication.succeeded`).

## Consequences
- Closes ADR-0041's explicitly-named gap for OAuth/SSO/SCIM/WebAuthn.
  `introspect` (read-only) and `GET`-only endpoints remain unaudited by
  design - audit records mutations and consequential authN/authZ outcomes,
  not reads.
- OAuth's `POST /oauth/authorize` (issuing an authorization code) is
  deliberately not audited - it is a precursor step, not a completed
  login; auditing both it and the subsequent `POST /oauth/token` call
  would double-count one logical login event. The token-issuance event is
  the one that matters (it is the point at which a credential a caller can
  actually use comes into existence).
- `AuditApiModule` is now the *only* module allowed to import both
  `AuditModule` and `AuthModule` together for a controller; any future
  controller needing both should follow this same composition-root shape,
  not attempt to have `AuditModule` import `AuthModule` again.
- Every new instrumentation point uses whichever of
  `AuditEventBatcherService` (fire-and-forget, batched, latency-sensitive
  paths) or `AuditLogRepository.record` (synchronous, immediately
  consistent, admin-CRUD paths) already matches the endpoint's own
  volume/consistency profile - not a blanket choice of one over the other.
- Still not instrumented, deliberately: `WellKnownController` (read-only
  discovery documents), SAML metadata (`GET .../metadata`, read-only), and
  failed-login/failed-SSO-callback paths (auditing failures as a distinct
  concern from auditing successful mutations was judged out of scope for
  this pass - a reasonable follow-up, not silently forgotten).
