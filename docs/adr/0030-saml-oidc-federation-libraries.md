# ADR-0030: `@node-saml/node-saml` + `openid-client@5` (pinned) for external federation

## Context
§5.1 requires SAML 2.0 SP support and generic OIDC Relying Party support for
external, per-tenant IdPs - a different concern from `jose`
(`TokenService`, this platform acting as its *own* OIDC Provider, §5.6).
Both need a real, spec-compliant library - hand-rolling SAML XML signature
validation or OIDC discovery/token-exchange/ID-token-verification is exactly
the kind of security-critical code this repo should not reimplement.

## Decision
- **SAML: `@node-saml/node-saml`** - the actively-maintained, standalone
  successor to `passport-saml`'s core `SAML` class, usable without pulling
  in Passport's strategy/session middleware (this repo has no Passport
  anywhere else and no reason to introduce it for one feature).
  `SamlService` builds a fresh `SAML` client per request from the resolved
  `TenantIdentityProvider` row - there is no single "the SAML config," every
  tenant's IdP is independently configured.
- **OIDC federation: `openid-client@5` (exact minor pinned, not `^6`)** - v6
  rewrote the package as ESM-only (`"type": "module"`), which is
  incompatible with this repo's CommonJS build (`tsconfig.json`'s
  `module: "commonjs"`, no `esModuleInterop`) without routing every call
  site through a dynamic `import()`. v5 is CommonJS-compatible, actively
  used in production by many OIDC RPs, and its API (`Issuer.discover`,
  `new issuer.Client(...)`, `client.authorizationUrl`/`client.callback`) is
  exactly what `OidcFederationService` needs. Revisit this pin if/when this
  repo's build moves to ESM output.

## Consequences
- Two different "OIDC" libraries exist in this codebase for two different
  roles: `jose` (this platform as Provider) and `openid-client` (this
  platform as Relying Party to a tenant's external IdP). This is
  intentional, not redundant - conflating them would couple this platform's
  own token format to whatever a specific external IdP's client library
  expects.
- `OidcFederationService` caches each provider's discovered `Issuer`/`Client`
  in an in-memory `Map` (1-hour TTL) to avoid a discovery-document fetch on
  every login. This cache is per-instance (not shared across horizontally
  scaled replicas) and is lost on restart - acceptable since discovery
  documents are the least frequently-changing config surface this module
  reads, but noted as a place a production deployment might want Redis
  fronting instead if it becomes a warm-cache reliability concern at scale.
- A `TenantIdentityProvider` pointed at an unreachable or misconfigured
  discovery URL fails closed - `SsoProviderUnavailableError` (§5.7's "what
  happens on IdP downtime"), never a silent fallback to an unauthenticated
  session.
