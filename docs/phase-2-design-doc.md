# Phase 2 Design Doc — Identity Core (OAuth2.1/OIDC/PKCE, JWT, IdentityService)

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 2 — OAuth2.1 Authorization Code + PKCE, refresh token rotation,
client_credentials, JWT access/ID token issuance, Redis-backed session/UserContext
caching, `IdentityService.ValidateToken`/`GetUserContext` gRPC. Depends on Phase 1's
schema (`Tenant`, `User`, `Role`, `Permission`, `RolePermission`, `UserRole`) being
already applied. SAML, per-tenant `TenantIdentityProvider` federation, SCIM 2.0, and
WebAuthn/Passkeys are Phase 3 (§8) — explicitly not in this phase.

## Problem

Phase 1 built a schema and a tenant-isolation guard with no way to *become* a bound
tenant context in the first place outside a seed script or test harness. Module 01
needs a real identity-issuing surface before any other module (or Module 01's own
later phases) can authenticate a request: something has to authenticate a user,
issue a token whose claims match §3.4's exact shape, verify that token on every
subsequent request, and let it expire/rotate/revoke correctly — all before RBAC/ABAC
enforcement (Phase 4), SSO (Phase 3), or the external GraphQL/REST API surface
(Phase 6) can assume a validated identity exists.

## Decision

The mandated stack (§1): OAuth 2.1 Authorization Code + PKCE (public clients),
Client Credentials (confidential clients / service integrations), refresh token
rotation with family-based reuse detection (ADR-0025), RS256-signed JWT access/ID
tokens (ADR-0024), Redis as a fast-path cache only — never system of record (§1) —
for both the refresh-token-family pointer and the `IdentityService.GetUserContext`
roles/permissions cache. A new `AuthModule` (`src/modules/auth`) owns five new
tables (`oauth_clients`, `user_credentials`, `signing_keys`, `authorization_codes`,
`refresh_tokens`), all following Phase 1's established patterns (`TenantScopedRepository`
+ RLS, except `oauth_clients` — ADR-0028 — and `signing_keys`, which is global
reference data like `Permission`, ADR-0024).

Since Module 01 has no login UI (and none is in scope for this module — see
ADR-0026), `POST /oauth/authorize` is an API-first stand-in that combines
resource-owner password authentication (ADR-0023's local-password bootstrap,
coexisting with Phase 3's SSO) with authorization-code issuance in one call.
`OAuthController`'s errors render RFC 6749/7009/7662's `{error, error_description}`
shape via a controller-scoped `OAuthErrorFilter` — deliberately *not* §3.4's generic
platform error envelope, since real OAuth client libraries parse the RFC shape, not
this platform's own.

`IdentityGrpcController` (`src/grpc`) is the first consumer of this module's own
output: it verifies a presented access token (signature, `iss`/`aud`/`exp`,
Redis-backed revocation check) and serves `GetUserContext` from
`UserContextCacheService`'s 60-second cache-aside over `UserContextResolverService`
(a new read path in `IdentityModule` joining `user_roles` → `roles` and
`role_permissions` → `permissions`).

## Blast radius

- Five new tables (migration `1700000005000-Module01Phase2AuthSchema`), additive —
  no change to any Phase 1 table or existing repository.
- New runtime dependencies: `jose` (JWS signing/verification), `ioredis` (Redis
  client), `bcryptjs` (password hashing).
- New infrastructure dependency: Redis (`docker-compose.yml`'s `redis` service,
  local dev only — production provisioning is infra work, see the readiness
  checklist). Every Redis-touching service (`UserContextCacheService`,
  `RefreshTokenService`, `TokenRevocationService`) fails open to Postgres on a Redis
  error — a Redis outage degrades latency, never correctness or availability (see
  `RedisService`'s own doc comment).
- First REST surface Module 01 itself mounts (`/oauth/*`, `/.well-known/*`) — Module
  02 mounted the repo's first HTTP/GraphQL surface in its own Phase 2, but nothing in
  Module 01 had a route before this.
- First gRPC contract Module 01 exposes (`IdentityService`), registered alongside
  Module 02's existing `EmployeeService`/`CalendarService` in the same microservice
  (`GrpcModule`, `main.ts`'s `package`/`protoPath` arrays).

## Rollback plan

Additive — reverting this phase means removing `AuthModule`/`RedisModule` from
`app.module.ts`, `IdentityGrpcController` from `GrpcModule`, and the identity.proto
entry from `main.ts`'s microservice options; Phase 1's schema, RLS, and repositories
are untouched. The migration's `down()` drops the five new tables. Nothing outside
this phase depends on it yet (no other module reads `oauth_clients`/`refresh_tokens`/
etc. directly — everything crosses the boundary through `IdentityService`'s gRPC
contract, per §3.3's own stated rationale for that boundary).

## Explicit assumptions (spec was ambiguous or silent here)

1. **Local password authentication exists in Phase 2**, ahead of SSO (Phase 3). See
   ADR-0023. §5's own framing ("real enterprise customers are split" between SSO and
   not) implies a non-SSO path needs to exist somewhere; Phase 2 is where the token
   issuance machinery it depends on lives, so it lands here.
2. **`POST /oauth/authorize` accepts resource-owner credentials directly**, not a
   browser redirect to a hosted login page. See ADR-0026 — flagged as explicitly not
   how a production deployment should expose this to end users.
3. **Device Authorization Flow, Dynamic Client Registration beyond a bootstrap-token-gated
   minimal endpoint, and WebAuthn/Passkeys are deferred.** §5.1 lists Device
   Authorization Flow as a supported protocol and §5.6 groups Dynamic Client
   Registration with Discovery/JWKS, but §8's own Phase 2 bullet names only
   "OAuth2.1/OIDC/PKCE, JWT issuance + rotation, session cache in Redis,
   IdentityService.ValidateToken/GetUserContext" — Device flow has no dependency on
   SSO/SCIM/WebAuthn and could move earlier if prioritized, but was left out to keep
   this phase's surface area reviewable. `POST /oauth/register` exists in minimal
   form (gated by a static bootstrap token, ADR-0026) because without *any* way to
   create an `OAuthClient` outside the seed script, the rest of this phase would be
   untestable against a running instance.
4. **`org_unit_id` in the JWT/`GetUserContext` response is a single nullable value**,
   projected from `user_roles.scope_org_unit_id` (§2.1's ABAC model allows multiple
   scoped role assignments per user) down to one value: if every role assignment
   shares the same scope, that scope is used; a genuinely mixed set of scopes yields
   `null` rather than an arbitrary pick. See `UserContextResolverService`'s own doc
   comment — full ABAC evaluation is Phase 4 scope.
5. **`client_credentials` tokens carry no roles/permissions** (`sub` is
   `client:<uuid>`, not a user id). §2.1's `UserRole`/ABAC model is user-centric; a
   client-level permission grant model isn't specified and wasn't invented here.
6. **`aud` is a fixed platform resource identifier** (`agno-core-api`, configurable
   via `OIDC_AUDIENCE`), matching §3.4's literal example, not per-client.

## Out of scope for this phase (do not build yet)

- SAML 2.0, per-tenant `TenantIdentityProvider` IdP config, SCIM 2.0 provisioning,
  WebAuthn/Passkeys (Phase 3).
- RBAC/ABAC *enforcement* (a permission-gated guard on any endpoint) — Phase 2 issues
  `roles`/`permissions` claims but nothing yet checks them against an operation.
  `PolicyService.GetActivePolicy` (Phase 4).
- `AuditService.RecordEvent`, NATS outbox publication of auth events (login,
  token issuance, revocation) — Phase 5. No audit trail is written by this phase yet.
- GraphQL BFF, the rest of §3.2's REST surface (`/v1/tenants`, `/v1/audit-log`,
  webhooks), Envoy gateway config, `Idempotency-Key`/rate-limiting cross-cutting
  requirements (Phase 6). `/oauth/*` is this phase's only REST surface.
- OpenTelemetry span wiring, SLO dashboards, chaos/game-day exercises (Phase 7).
- A real KMS/HSM for signing key material, Vault-issued rotated DB credentials, load
  testing against the stated capacity targets — see the production readiness
  checklist for the full, honest list.
