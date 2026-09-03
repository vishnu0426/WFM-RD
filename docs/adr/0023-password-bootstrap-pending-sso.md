# ADR-0023: Local password credential as a Phase 2 bootstrap, alongside (not instead of) SSO

## Context
§5's Authorization Code + PKCE flow needs *some* way to authenticate the resource
owner. Real federation (SAML, per-tenant OIDC IdP config via `TenantIdentityProvider`,
SCIM provisioning) is explicitly Phase 3 scope (§8). Without it, Phase 2 has no way to
issue a single token, let alone demonstrate rotation/reuse-detection end to end.

## Decision
Add `core.user_credentials` (bcrypt password hash, lockout counters) as a coexisting
authentication mechanism alongside `User.externalIdpId` (Phase 3's SSO linkage) - not
a replacement for it. A user may have a local password credential, an external IdP
link, both, or neither (invited-but-not-yet-provisioned). `PasswordAuthService` is the
only consumer in Phase 2; Phase 3 adds SAML/OIDC assertion validation as a second,
independent path into the same authorization-code issuance step.

Password hashing uses `bcryptjs` (pure JS, no native build toolchain dependency) at a
configurable cost factor (`PASSWORD_HASH_COST_FACTOR`), not argon2id - see the
production readiness checklist for why this is flagged as a trade-off to revisit.

## Consequences
- `POST /oauth/authorize` (ADR-0026) is password-only in this phase. A tenant that
  only wants SSO still gets a working local-password path unless/until Phase 3 adds a
  per-tenant policy to disable it - not built yet, flagged as an explicit gap.
- Account lockout (5 failed attempts, 15-minute lock) is enforced in
  `PasswordAuthService`, not the database - a future concurrent-request race on the
  failed-attempt counter (two simultaneous wrong-password requests both reading
  `failedLoginAttempts` before either writes) could under-count by one. Acceptable for
  Phase 2 (worst case: one extra allowed attempt before lockout); a `SELECT ... FOR
  UPDATE` or an atomic increment would close this gap if it matters before Phase 3.
- `amr` claim value for this path is `["pwd"]` - Phase 3 adds `"webauthn"`, and an OTP
  second factor would add `"otp"`, per §3.4's claim shape.
