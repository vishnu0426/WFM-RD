# Phase 3 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5).

## Delivered in this phase (application code)

- [x] Per-tenant `TenantIdentityProvider` config (SAML + generic OIDC), admin
      CRUD (`/v1/identity-providers`), read-open/write-gated RLS (ADR-0029).
- [x] SAML 2.0 SP: AuthnRequest generation, POST-binding assertion
      validation (`@node-saml/node-saml`), SP metadata endpoint.
- [x] Generic OIDC federation (discovery, authorization code exchange,
      ID token verification) via `openid-client@5`, covering every vendor
      §5.1 names that speaks OIDC (Entra ID, Okta, Auth0, Keycloak, Ping,
      OneLogin, Google Workspace, GitHub Enterprise, GitLab, Apple) through
      one code path, per-tenant config only (ADR-0030).
- [x] Shared SSO callback dispatch (`GET`/`POST /v1/auth/sso/callback`),
      Redis-backed pending-request bridge across the external redirect
      (ADR-0031), JIT user provisioning/linking on first federated login.
- [x] SCIM 2.0 `/scim/v2/Users` and `/scim/v2/Groups` (RFC 7644): list with a
      documented filter subset, get, create, replace, patch, delete;
      `ServiceProviderConfig`/`ResourceTypes` discovery; Group<->Role mapping
      (ADR-0032).
- [x] §5.7's forced mid-session revocation on SCIM deprovisioning - every
      concurrent refresh-token family for the user, plus the matching Redis
      fast-path cache entries, not just the database rows.
- [x] WebAuthn/Passkeys: registration (auth-required) and authentication
      (public, tenant-resolved via `client_id`) ceremonies via
      `@simplewebauthn/server`, bridged into `POST /oauth/authorize` as an
      alternate credential (ADR-0033), with authenticator clone-detection
      (signature counter must strictly increase).
- [x] Per-tenant auth-method policy (`PolicyType.AUTH_METHOD_POLICY`, reusing
      Phase 1's JSONB mechanism, ADR-0003) - required/allowed method
      enforcement checked before any credential is evaluated.
- [x] `§5.7` error handling: IdP unavailable (`SsoProviderUnavailableError`,
      502), invalid/expired assertion (`SsoAssertionInvalidError`, 400),
      expired SSO/WebAuthn ceremony state (400) - all distinct, typed error
      codes, not a generic 500.
- [x] RLS on every new tenant-scoped table, `migration-lint.ts` extended
      accordingly; unit tests (filter parser, PATCH op merging, session
      bridges, auth-method policy) and integration tests (RLS isolation for
      both new tables, full SCIM provisioning + forced-revocation flow)
      against real Postgres + Redis.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **LDAP/AD, per-vendor OIDC adapters (Apple's rotating JWT client
      secret, etc.), SCIM Bulk, `/scim/v2/Schemas`, SAML/OIDC logout.** See
      ADR-0034 for the full list and reasoning behind each.
- [ ] **A real KMS/HSM for `TenantIdentityProvider.oidcClientSecret`.**
      Plaintext database column, same posture and same gap Phase 2 already
      flagged for `SigningKey.privateKeyPem` (ADR-0024) - this is now the
      second highest-leverage secret class in the schema.
- [ ] **The full RFC 7644 SCIM filter and PATCH grammar.** This phase
      supports the subset every mainstream connector's default provisioning
      behavior actually uses (ADR-0032) - a SCIM client relying on `and`/
      `or`/`co`/`pr` filters or complex-attribute PATCH paths will not work
      correctly against this implementation.
- [ ] **Fine-grained SCIM authorization.** `ScimAuthGuard` accepts any valid
      `client_credentials` token for the tenant - real per-client scoping
      needs Phase 4's RBAC enforcement, same deferral already noted for
      `POST /oauth/register`'s bootstrap token (Phase 2, ADR-0026).
- [ ] **A hosted, browser-rendered WebAuthn/passkey UI.** The ceremony
      endpoints are real and spec-correct; there is still no frontend in
      this repo to call `navigator.credentials.create()/.get()` against
      them - same posture as ADR-0026's password-login gap.
- [ ] **`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` production configuration.**
      Must be set to match whatever frontend actually serves the WebAuthn
      JS; the `.env.example` defaults are `localhost`-shaped placeholders.
- [ ] **Load testing** for the SSO callback path and SCIM provisioning
      throughput - no numbers have been measured; §0.5's "SSO callback
      success rate >= 99.9%" SLO has a real implementation to measure
      against now but no measurement has been taken.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Same explicit
      non-goal as every previous phase (§9 of the source spec) - this phase
      implements SAML/OIDC/SCIM/WebAuthn per their respective RFCs and
      defends new tables the way Phase 1/2 defended theirs, which is not a
      completed security audit, especially for a feature surface this
      identity-critical.
