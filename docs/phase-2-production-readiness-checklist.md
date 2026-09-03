# Phase 2 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5).

## Delivered in this phase (application code)

- [x] OAuth 2.1 Authorization Code + PKCE (S256-only, ADR-0027), Client Credentials,
      and refresh token grants, all through `POST /oauth/token`.
- [x] Refresh token rotation with reuse detection — family-based full revocation on
      replay, and on a lost compare-and-swap race (ADR-0025).
- [x] RS256-signed JWT access tokens matching §3.4's claim shape exactly, plus OIDC
      ID tokens, `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json`.
- [x] Access token revocation (`POST /oauth/revoke`) via a Redis blacklist keyed by
      `jti`, TTL'd to the token's remaining lifetime.
- [x] Token introspection (`POST /oauth/introspect`, RFC 7662) for both access and
      refresh tokens.
- [x] `IdentityService.ValidateToken`/`GetUserContext` gRPC contract + implementation,
      with a 60-second Redis cache-aside in front of the Postgres roles/permissions join.
- [x] Local password authentication with bcrypt hashing and failed-attempt lockout
      (ADR-0023), as a Phase 2 bootstrap alongside (not instead of) Phase 3's SSO.
- [x] RLS on every new tenant-scoped table (`user_credentials`, `authorization_codes`,
      `refresh_tokens`), plus `oauth_clients`' deliberate read-open/write-gated
      variant (ADR-0028); `signing_keys` is global reference data with no RLS,
      matching `Permission`'s existing posture (ADR-0024).
- [x] `migration-lint.ts` extended to cover the four new tenant-scoped tables — same
      database-fact CI gate as Phase 1, not a new mechanism.
- [x] Unit tests (password hashing, PKCE challenge/verify + format validation,
      signing key bootstrap/rotation/grace-window, JWT issue/verify/tamper/expiry) and
      integration tests (full authorization_code+PKCE→token→refresh-rotation→reuse-detection
      flow and RLS isolation for every new table, against real Postgres + Redis).
- [x] `docker-compose.yml`/CI updated with a Redis service; every Redis-touching
      service fails open to Postgres on a Redis error (see `RedisService`'s doc comment).

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **A real KMS/HSM for signing key material.** `core.signing_keys.private_key_pem`
      is a plaintext database column (ADR-0024) — this is the single highest-leverage
      secret in the platform. Must move behind AWS KMS/GCP Cloud KMS/Vault Transit (or
      equivalent) before any production traffic relies on tokens this issues.
- [ ] **Vault (or equivalent) for Redis/DB credential issuance.** `REDIS_PASSWORD` and
      `OAUTH_CLIENT_REGISTRATION_TOKEN` are static `.env.example` placeholders, same
      posture Phase 1 already flagged for `agno_app`/`agno_migrator`.
- [ ] **A hosted, CSRF-protected login UI in front of `POST /oauth/authorize`.**
      This phase's endpoint is an explicit API-first stand-in (ADR-0026) — accepting
      `username`/`password` directly at a JSON API endpoint is a materially weaker
      posture than a real browser-rendered login form, and is not how this should be
      exposed to end users in production.
- [ ] **Real admin-permission gating on `POST /oauth/register`.** Currently a static
      bootstrap token (ADR-0026); needs Phase 4's RBAC enforcement to become a
      properly-scoped admin operation.
- [ ] **Load testing against §0.5's stated targets** (`IdentityService.ValidateToken`
      p99 < 50ms, 99.95% availability, SSO callback success rate ≥ 99.9% — the last of
      these has no callback to test yet, that's Phase 3). No load test exists; the
      60-second `UserContextCacheService` TTL and the Redis-fast-path refresh-token
      lookup are sized by reasoning about request patterns, not measurement.
- [ ] **Automatic/scheduled signing key rotation.** `SigningKeyService.rotate()` is a
      real, working operation but is only ever invoked manually (a runbook procedure,
      see docs/runbook.md) — no scheduler, no automatic rotation cadence.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Explicit non-goal (§9 of the
      source spec) — this phase implements OAuth2.1/OIDC per its RFCs and defends the
      new tables the same way Phase 1 defended its own, but that is not a completed
      security audit.
- [ ] **SAST / dependency scanning / SBOM / provenance attestation** beyond what
      Phase 1 already flagged as missing from `ci.yml` (lint, type-check, tests,
      gitleaks only).
- [ ] **A concurrency-safe failed-login-attempt counter.** `PasswordAuthService`'s
      lockout logic has a small race window under truly concurrent wrong-password
      requests (see ADR-0023's consequences) — low severity, flagged rather than fixed
      with a `SELECT ... FOR UPDATE` this phase didn't judge worth the added lock
      contention yet.
- [ ] **`Idempotency-Key` support on `/oauth/*` POST endpoints.** §3.2's cross-cutting
      REST requirement is explicitly Phase 6 scope platform-wide; this phase's
      endpoints don't have it yet (a retried `POST /oauth/token` for `refresh_token`
      is exactly the race ADR-0025's "Consequences" section discusses).
