# ADR-0026: `POST /oauth/authorize` combines resource-owner auth with code issuance (no hosted login UI)

## Context
RFC 6749's Authorization Code flow assumes a browser: `GET /oauth/authorize` renders a
login page (or redirects to one), the user authenticates *on that page*, and only then
does the authorization server redirect back to the client with a code. This repo has
no frontend of any kind - Module 01 is a backend service, and a login UI is out of
scope for this module regardless of phase (it would belong to whatever module owns the
Identity & Audit Console, §2a of the source spec, not Module 01's own deliverable).

## Decision
`POST /oauth/authorize` accepts `client_id`, `redirect_uri`, PKCE parameters, *and*
`username`/`password` in one request, authenticates the resource owner and issues the
code atomically. This is not RFC 6749-compliant as written (`username`/`password`
are not part of a real `/authorize` request) - it is this repo's API-first stand-in
for "the login page's form-submission target." A real deployment puts a
browser-rendered login page in front of an endpoint shaped like this one; the page
collects credentials and POSTs them here instead of this API accepting them directly
from an untrusted redirect-based flow. Also gated by static, RFC7591-lite
`POST /oauth/register` (bootstrap token, `X-Registration-Token`) for the same reason:
no admin UI/RBAC enforcement exists yet to gate client registration properly (that's
Phase 4).

## Consequences
- `POST /oauth/authorize`'s response is JSON (`{code, state}`), not an HTTP redirect -
  a real browser-facing deployment's login page would perform the redirect itself
  using these values, this endpoint doesn't attempt to emulate a redirect response.
- This is explicitly flagged as **not** how a production deployment should expose this
  endpoint to end users directly - credentials sent to a JSON API endpoint outside a
  proper browser-rendered, CSRF-protected login form is a materially different (worse)
  security posture than the standard flow, and this ADR exists specifically so that
  gap is not silently implied to be resolved. See the production readiness checklist.
- `POST /oauth/register`'s static bootstrap token is a stand-in for real
  admin-permission gating (Phase 4's RBAC enforcement, §4). Anyone holding
  `OAUTH_CLIENT_REGISTRATION_TOKEN` can register a client for *any* tenant (the
  request itself supplies `X-Tenant-Id`) - acceptable only because this token is
  operator-held infrastructure config, not distributed to end users or tenants.
