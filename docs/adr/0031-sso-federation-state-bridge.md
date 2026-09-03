# ADR-0031: SSO federation state bridge - Redis pending-request, shared callback route, JIT provisioning

## Context
A browser-driven SSO login leaves this platform's control for the external
IdP round trip. The original `/oauth/authorize`-shaped request (which
client, which `redirect_uri`, which PKCE challenge, which original `state`)
has to survive that round trip and be recovered when the IdP redirects back
- OAuth/OIDC has no built-in mechanism for "resume the request that started
this," and §1 forbids treating Redis as anything but a cache (so this can't
just be "put it in a database row and never expire it").

## Decision
1. **`SsoLoginService`** stores the pending request in Redis keyed by a
   random id (`sso:pending:<id>`, 10-minute TTL), single-use (deleted on
   first read). That id is threaded through as SAML's `RelayState` /
   OIDC's `state` parameter - the one piece of client-supplied state both
   protocols guarantee gets echoed back unmodified.
2. **One route, two HTTP methods**: `GET /v1/auth/sso/callback` (OIDC's
   redirect-with-query-params) and `POST /v1/auth/sso/callback` (SAML's
   HTTP-POST binding form) both delegate to the same private
   `dispatchCallback` logic in `SsoController` - satisfying §3.2's "shared
   SAML + OIDC callback handler" at the logic level, since the two
   protocols' browser mechanics are different HTTP methods by nature, not a
   detail this platform can unify away.
3. **JIT (just-in-time) user provisioning**: `SsoController.findOrProvisionUser`
   matches, in order, an existing `external_idp_id` link, then an existing
   user by email within the tenant (linking `external_idp_id` onto it), then
   creates a new `User` row. A federated user never needs a separate manual
   provisioning step before their first successful login - SCIM (§5.3), if
   configured, would normally provision the row ahead of time, but SSO does
   not depend on SCIM having run first.
4. **Failure redirects, not JSON errors**: once `dispatchCallback` has
   recovered the pending request (and therefore knows the original client's
   `redirect_uri`), any federation failure (invalid assertion, IdP
   unavailable, no email attribute) redirects back to that `redirect_uri`
   with an OAuth-style `?error=access_denied&error_description=...` query
   string - matching what a real IdP does, and letting the *client's* own
   error handling take over, since this is a browser navigation the
   client's code isn't synchronously inspecting the way it would inspect a
   JSON API response.

## Consequences
- A federation failure that happens *before* the pending request is
  recovered (unknown `tenantIdpId`, expired/tampered RelayState/state) has
  nowhere safe to redirect to and returns this platform's own generic JSON
  error envelope (§3.4) instead - a real deployment should render this as a
  plain error page for a browser-facing route, which is Phase 6+ REST/UI
  polish, not built here.
- The 10-minute pending-request TTL bounds how long a user can sit on an
  external IdP's login page before the flow expires and must be restarted
  from `/v1/auth/sso/login/:tenantIdpId` again - a deliberate, generous
  window for a real login page, not a security boundary in itself (the
  `codeChallenge`/PKCE verification still happens at the final
  `/oauth/token` exchange, same as the password path).
- No SAML Single Logout (SLO) or OIDC RP-Initiated Logout is implemented -
  `TenantIdentityProvider.samlSloUrl` is stored (so metadata generation and
  a future SLO implementation have somewhere to read it from) but nothing
  calls it yet. Flagged in the production readiness checklist.
