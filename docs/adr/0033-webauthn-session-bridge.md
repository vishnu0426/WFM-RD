# ADR-0033: WebAuthn as an alternate `/oauth/authorize` credential, via a Redis session bridge

## Context
§5.4 requires WebAuthn/Passkeys "as a first-class MFA/primary-auth option
alongside SSO." `POST /oauth/authorize` (ADR-0026) already combines
resource-owner authentication with authorization-code issuance in one call;
WebAuthn's ceremony (options -> browser `navigator.credentials` call ->
verify) is a separate multi-step ceremony this repo's `/oauth/authorize`
DTO can't absorb directly without either (a) inventing an entirely separate
authorization-code-issuing code path for WebAuthn (duplicating PKCE/scope/
client validation), or (b) finding a way to feed a completed WebAuthn
ceremony's result into the *existing* `/oauth/authorize` path.

## Decision
(b), via `WebAuthnSessionService` (deliberately placed in `AuthModule`, not
`WebAuthnModule` - see that service's own doc comment on why, to avoid a
module dependency cycle). `WebAuthnController.authenticateVerify`, on a
successful assertion, calls `webauthnSessions.issue({tenantId, userId})` and
returns an opaque `webauthn_session_token` (5-minute TTL, single-use). The
client then calls `POST /oauth/authorize` with `webauthn_session_token` in
place of `username`/`password` - `OAuthController.authorize` accepts
exactly one of the two credential shapes (runtime-checked, not DTO-level -
see `AuthorizeRequestDto`'s doc comment) and both converge on the same
authorization-code issuance logic afterward.

`AuthMethodPolicyService.assertMethodPermitted` is checked twice for the
WebAuthn path - once in `WebAuthnService.verifyAuthentication` (before
minting the session token at all) and again in `OAuthController.authorize`
(before consuming it) - deliberately redundant defense-in-depth, the same
posture ADR-0027 takes toward PKCE's `S256`-only check (DTO + service +
database, three independent enforcement points).

## Consequences
- A `webauthn_session_token` is a bearer credential for exactly one thing
  (mint an authorization code as the named user, for the tenant it was
  issued in) for five minutes. It is not an access token and grants no API
  access on its own - `WebAuthnSessionService.consume` is only ever called
  from `OAuthController.authorize`.
- Passkey registration (`POST /webauthn/register/*`) requires an existing,
  valid user access token (`AccessTokenGuard`) - you register a passkey
  *for* an account you can already authenticate into by some other means.
  This means a tenant cannot make WebAuthn the *only* way to ever create an
  account's first credential; some other authenticated path (password, or
  SCIM/SSO provisioning followed by a first password-authenticated login to
  register a passkey) must exist first. Not a limitation this phase
  resolves - flagged as a real operational consideration for a
  webauthn-required tenant's onboarding flow.
- Authenticator clone-detection (`WebAuthnService.verifyAuthentication`'s
  counter check) fails the specific ceremony but does not itself revoke any
  other session or credential - a suspected-cloned credential should be
  deleted via `DELETE /webauthn/credentials/:id` by an operator/the user,
  which this phase supports but does not trigger automatically.
