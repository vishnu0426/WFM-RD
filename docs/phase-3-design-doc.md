# Phase 3 Design Doc — Enterprise SSO (SAML 2.0, per-tenant IdP config, SCIM 2.0, WebAuthn/Passkeys)

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 3 — SAML 2.0 SP support, per-tenant `TenantIdentityProvider`
config connected to a shared SSO callback dispatcher, SCIM 2.0 provisioning
(`/scim/v2/Users`, `/scim/v2/Groups`), WebAuthn/Passkeys as a first-class
credential alongside password auth. Depends on Phase 2's OAuth2.1/OIDC token
issuance, refresh-token rotation, and Redis-backed caching already being in
place — this phase adds *how a user gets authenticated* in the enterprise
cases Phase 2's local password bootstrap doesn't cover, not a new token
format or issuance mechanism.

## Problem

Phase 2 gave every tenant exactly one way to authenticate a user: a local
password (ADR-0023), explicitly framed as a bootstrap pending real SSO. That
is not viable for the enterprise/BPO tier customers §5.1 describes ("real
enterprise customers are split" between SAML and OIDC IdPs) — those
customers need their own IdP to be the source of truth for who can log in,
need their HR/IdP system to provision and deprovision accounts automatically
(SCIM), and increasingly expect phishing-resistant WebAuthn/passkey login as
an option. None of this can bolt onto Phase 2's token issuance from outside;
it has to plug into the same authorization-code-issuing core so a federated,
SCIM-provisioned, or passkey-authenticated login produces the exact same
kind of access/refresh token pair Phase 2 already built rotation and
revocation for.

## Decision

Three new modules (`SsoModule`, `WebAuthnModule`, `ScimModule`) sit
alongside `AuthModule` rather than inside it, each importing `AuthModule`
for the pieces they need to reuse (`AuthorizationCodeService`,
`RefreshTokenService`, `TokenService`, `OAuthClientAuthService`,
`PkceService`) rather than duplicating any of it. Two new tables:
`tenant_identity_providers` (§5.5, ADR-0029's read-open/write-gated RLS —
the same structural shape ADR-0028 established for `oauth_clients`, for the
same reason) and `webauthn_credentials` (§5.4, standard closed tenant
isolation). `core.users` gains two nullable columns (`given_name`,
`family_name`) SCIM's core schema needs and Phase 1 never anticipated.

**SAML/OIDC federation** (`SsoModule`, ADR-0030, ADR-0031): `SamlService`
(`@node-saml/node-saml`) and `OidcFederationService` (`openid-client@5`,
pinned — v6 is ESM-only) each turn a `TenantIdentityProvider` row plus an
inbound assertion/authorization-code into a `FederatedIdentity` (subject,
email, name, groups). `SsoLoginService` bridges the external redirect round
trip via a short-lived Redis-stored pending request, threaded through as
SAML's RelayState / OIDC's `state`. On successful federation,
`SsoController` JIT-provisions or links a `User` row and issues this
platform's own authorization code through the same `AuthorizationCodeService`
Phase 2's password path uses — from `/oauth/token` onward, a federated login
is indistinguishable from a password login except for its `amr` claim
(`["saml"]`/`["oidc"]` vs. `["pwd"]`).

**WebAuthn/Passkeys** (`WebAuthnModule`, ADR-0033): `@simplewebauthn/server`
drives registration (requires an existing access token — you register a
passkey for an account you can already log into some other way) and
authentication (public, resolves tenant via `client_id` like the password
path). A successful authentication ceremony produces a
`webauthn_session_token` (`WebAuthnSessionService`, deliberately living in
`AuthModule`) that `POST /oauth/authorize` accepts in place of
`username`/`password` — the same convergence-onto-one-path pattern as SSO.

**SCIM 2.0** (`ScimModule`, ADR-0032): `/scim/v2/Users` maps directly onto
`User`; `/scim/v2/Groups` maps onto tenant-scoped `Role` + tenant-wide
`UserRole` membership. Authenticated by `ScimAuthGuard` (any valid
`client_credentials` access token — the inverse of `AccessTokenGuard`, which
rejects that same token shape). Deactivating a user via SCIM (`PATCH
.../active: false` or `DELETE`) calls
`RefreshTokenService.revokeAllSessionsForUser`, satisfying §5.7's "a SCIM
deprovisioning request for a user mid-session must force session revocation"
— every concurrent session, across every device, not just the one that
happened to trigger the deprovisioning call.

**Per-tenant auth method policy** (§5.4): `AuthMethodPolicyService` reads a
new `PolicyType.AUTH_METHOD_POLICY` row through Phase 1's existing JSONB
`Policy.definition` mechanism (ADR-0003) — no new table, exactly the
extensibility that mechanism was built for. Checked before either the
password or WebAuthn credential path is even evaluated in
`OAuthController.authorize`.

## Blast radius

- Two new tables + two new columns on `core.users`, additive. No change to
  any Phase 1/2 table's existing columns or RLS policies.
- Three new modules, all importing (never modifying) `AuthModule`/
  `IdentityModule`/`PolicyModule`. `OAuthController.authorize` and
  `AuthorizeRequestDto` gain the WebAuthn credential branch — additive, the
  password path's existing behavior is unchanged (see the "Explicit
  assumptions" section for the one contract addition: two mutually
  exclusive credential shapes instead of one fixed shape).
- New runtime dependencies: `@node-saml/node-saml`, `openid-client@5`,
  `@simplewebauthn/server`.
- First REST surfaces at `/v1/auth/sso/*`, `/v1/identity-providers`,
  `/webauthn/*`, `/scim/v2/*`.

## Rollback plan

Additive — reverting this phase means removing `SsoModule`/`WebAuthnModule`/
`ScimModule` from `app.module.ts` and reverting `OAuthController.authorize`'s
credential branch back to password-only. The two new migrations' `down()`
drop the new tables/columns and narrow `policies_type_check` back. Phase 2's
password-only flow keeps working unchanged throughout — nothing in Phase 2
depends on anything built in this phase.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`POST /oauth/authorize` now accepts two mutually exclusive credential
   shapes** (`username`+`password` XOR `webauthn_session_token`), checked at
   runtime rather than declaratively — see `AuthorizeRequestDto`'s doc
   comment. This is the one behavioral change to an existing Phase 2
   contract; every existing password-only caller is unaffected.
2. **SCIM's `externalId` reuses `User.external_idp_id`** rather than a
   separate column — in practice both represent "this IdP's identifier for
   this user," and SCIM provisioning + SSO federation are usually driven by
   the same source IdP for a given tenant. See ADR-0032's sibling reasoning
   in ADR-0034 for why a second, speculative column wasn't added.
3. **The shared SSO callback handler is one route, two HTTP methods** (`GET`
   for OIDC, `POST` for SAML) — see ADR-0031. §3.2 says "shared ... callback
   handler," which this reads as shared *logic*, not literally one HTTP verb
   forced onto both protocols' inherently different browser mechanics.
4. **JIT user provisioning on first SSO login** — not explicitly required by
   the spec, but without it, SSO would only work for users SCIM already
   provisioned, which contradicts SAML/OIDC being usable independently of
   SCIM being configured at all.
5. **A tenant's local-password path stays available by default** unless an
   `auth_method_policy` row says otherwise — Phase 2's existing behavior is
   the default, not silently replaced by this phase's new options.

## Out of scope for this phase (do not build yet)

- LDAP/AD, per-vendor OIDC quirks (Apple/GitHub Enterprise/GitLab beyond
  generic OIDC), SCIM Bulk operations, `/scim/v2/Schemas`, SAML/OIDC logout
  — see ADR-0034 for the full list and reasoning.
- RBAC/ABAC *enforcement* using the roles/permissions this phase's SCIM
  Groups can now provision — still Phase 4.
- Audit trail entries for SSO logins, SCIM provisioning events, or WebAuthn
  registrations — `AuditService.RecordEvent`/NATS publication is Phase 5;
  nothing in this phase writes to `audit_log` yet.
- A real KMS/HSM for `TenantIdentityProvider.oidcClientSecret` — same
  posture, same gap, as ADR-0024 already flagged for `SigningKey`.
