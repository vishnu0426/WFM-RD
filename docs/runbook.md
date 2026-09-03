# Runbook — Module 01

Covers Phase 1 (schema & migrations), Phase 2 (identity core: OAuth2.1/OIDC,
JWT signing keys, refresh tokens), Phase 3 (SSO, SCIM, WebAuthn), Phase 4
(RBAC/ABAC enforcement, Policy engine API), Phase 5 (audit event
publishing, `AuditService.RecordEvent`), Phase 6 (`/v1/tenants`, the
GraphQL BFF, webhooks, `Idempotency-Key`, Envoy), and Phase 7 (tracing,
metrics, health checks, the SLO dashboard, chaos/game-day exercises, the
incident postmortem template, and the JWT-derived tenant-context hardening
in ADR-0049). All seven phases in the source spec are now covered.

## Running migrations

```bash
docker-compose up -d
cp .env.example .env   # edit if your local Postgres differs
npm ci
npm run migration:run
```

## Rolling back the last migration

```bash
npm run migration:revert
```

Only reverts the most recently applied migration batch. Since nothing
external depends on this schema yet (no deployed service reads/writes it),
rollback in Phase 1 is a non-event - this section will need real teeth
(data-loss risk assessment, dual-write/dual-read migration path per §0.5)
starting the first phase that ships with real tenant data at rest.

## `audit_log` partition maintenance (local dev)

The initial migration creates four monthly partitions (one month back,
current month, two months forward) via a one-time `DO` block. **Nothing
automatically creates the next partition.** If `now()` drifts past the last
provisioned partition's upper bound, inserts into `core.audit_log` will fail
with a "no partition of relation ... found for row" error - by design (see
ADR-0005): a silent default/catch-all partition would hide the fact that
partition provisioning fell behind.

To add a partition manually for local dev:

```sql
CREATE TABLE core.audit_log_2027_01 PARTITION OF core.audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
```

**Production**: this should be `pg_partman`-managed (create N months ahead on
a schedule, retire/detach partitions per the `data_retention` policy type),
not a hand-run `CREATE TABLE`. Not implemented in this repo - see
`docs/production-readiness-checklist.md`.

## Seeding local dev data

```bash
npm run seed
```

Idempotent (checks for existing rows before inserting) - safe to re-run.
Creates baseline permissions, three system roles (`platform_admin`,
`tenant_admin`, `employee`), one demo tenant, one demo user, a demo overtime
policy, two demo audit log entries (one `system`, one `ai_agent` with
`ai_rationale` populated), and one notification preference.

## Verifying tenant isolation / RLS after a schema change

```bash
npm run migration:lint       # RLS enabled + tenant_id-first indexes, DB-fact check
npm run test:integration     # exercises the guard + RLS together, incl. bypass scenarios
```

If you add a new tenant-scoped table, both of the above will fail until you
add RLS policies for it - that's the intended trip-wire, not a bug in the
check.

## Phase 2 - Redis for local dev

```bash
docker-compose up -d   # now also starts a redis service
```

`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` in `.env.example` point the app at it.
Every Redis-touching service (`UserContextCacheService`, `RefreshTokenService`,
`TokenRevocationService`) fails open to Postgres on a Redis error - a down Redis
degrades latency (extra Postgres round trips), not correctness or availability.
There is nothing to "recover" in Redis after an outage; it repopulates itself
from Postgres on the next request.

## Phase 2 - Rotating a signing key

Signing keys (`core.signing_keys`) are **not** rotated automatically. To rotate:

```ts
// One-off script, or a REPL against the running app's DI container:
await signingKeyService.rotate();
```

This generates a new RSA keypair, marks it `active`, and retires the previous
key (still verifiable for 30 minutes - `RETIRED_KEY_GRACE_PERIOD_MS`,
ADR-0024 - so in-flight access tokens signed by the old key don't suddenly
fail verification). After the grace window elapses, `GET
/.well-known/jwks.json` stops advertising the retired key and tokens signed
by it stop verifying.

**Rotate immediately (don't wait for a scheduled window) if:** the
`signing_keys` table or its backing storage is suspected compromised, an
employee with production DB access is offboarded under suspicious
circumstances, or a token is found in a place it shouldn't be (a public log,
a leaked debug dump). There is no automatic revocation of tokens already
issued by the compromised key short of the 30-minute grace window expiring -
if a faster cutoff is needed, reduce `RETIRED_KEY_GRACE_PERIOD_MS` and
redeploy, or blacklist specific known-compromised `jti`s via
`TokenRevocationService.revoke` if they're known individually.

**Production**: this should be KMS/HSM-backed key generation triggered by an
on-call runbook or an automated rotation schedule, not a manual REPL command
against a plaintext-in-Postgres private key - see
`docs/phase-2-production-readiness-checklist.md`.

## Phase 2 - Revoking a compromised refresh token / session

```bash
curl -X POST https://<host>/oauth/revoke \
  -u '<client_id>:<client_secret>' \
  -d 'token=<refresh_token>'
```

Revokes the *entire family* the presented token belongs to (ADR-0025) - every
refresh token ever rotated from that original login, not just the one
presented. If only the access token is known (not the refresh token), use
the same endpoint with `token_type_hint=access_token`; this blacklists that
token's `jti` in Redis until its natural expiry (at most 12 minutes later)
but does **not** revoke its refresh token family - revoke both if the whole
session needs to be killed immediately.

## Phase 2 - Diagnosing an unexpected `invalid_grant` on `/oauth/token`

1. **Expired code/token** - authorization codes live 60 seconds; refresh
   tokens live 30 days sliding. Check `authorization_codes.expires_at` /
   `refresh_tokens.expires_at` for the row (if it's still there - see below).
2. **Reuse detected (ADR-0025)** - query `core.refresh_tokens WHERE family_id
   = <family>` and look for a `status = 'revoked'` row with
   `revoked_reason = 'reuse_detected'` or `'concurrent_rotation_conflict'`.
   The latter means two requests raced to rotate the same token - if this is
   happening repeatedly for one client, that client is very likely double-
   submitting refresh requests (a retry-on-timeout bug), not being attacked.
3. **PKCE mismatch** - the client's stored `code_verifier` doesn't match what
   it sent as `code_challenge` at `/oauth/authorize`. Not visible server-side
   beyond the generic `invalid_grant` (§ADR-0027 - the response is
   deliberately identical to every other `invalid_grant` cause, including
   reuse, so a client-side bug and an attack look the same to the caller).

## Phase 3 - Onboarding a new SAML IdP for a tenant

1. Get the IdP's metadata from the tenant admin: entity ID, SSO URL, signing
   certificate (PEM). For SP-initiated setup, share this platform's SP
   metadata first: `GET /v1/auth/sso/:tenantIdpId/metadata` - but the row
   has to exist before that URL resolves, so:
2. `POST /v1/identity-providers` (with `X-Tenant-Id` set to the tenant):
   ```json
   {
     "name": "Acme Corp Okta",
     "protocol": "saml",
     "samlEntityId": "http://www.okta.com/...",
     "samlSsoUrl": "https://acme.okta.com/app/.../sso/saml",
     "samlCertificate": "-----BEGIN CERTIFICATE-----..."
   }
   ```
3. Send the tenant admin the resulting `GET /v1/auth/sso/:tenantIdpId/metadata`
   URL to import into their IdP's SP connector config (or hand them the ACS
   URL directly: `{OIDC_ISSUER}/v1/auth/sso/callback`, entity ID
   `{OIDC_ISSUER}/sso/{tenantIdpId}`).
4. Test with `GET /v1/auth/sso/login/{tenantIdpId}?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256`
   from a browser - should redirect to the IdP's login page, then back to
   the client's `redirect_uri` with a `code` on success.

## Phase 3 - Onboarding a new OIDC IdP for a tenant

Same `POST /v1/identity-providers` flow, `protocol: "oidc"`, needs
`oidcDiscoveryUrl` (the IdP's `.well-known/openid-configuration` URL),
`oidcClientId`, `oidcClientSecret` (register a client in the IdP's admin
console first, with redirect URI `{OIDC_ISSUER}/v1/auth/sso/callback`). No
metadata endpoint for OIDC - discovery is the IdP's own document, not this
platform's.

## Phase 3 - Diagnosing an SSO login failure

1. **`SSO_PROVIDER_UNAVAILABLE` (502)** - the IdP's discovery endpoint or
   token endpoint couldn't be reached. Check the IdP's own status page first;
   this is IdP downtime (§5.7), not this platform's fault by default.
2. **`SSO_ASSERTION_INVALID` (400)** - SAML signature/certificate validation
   failed (expired cert is the most common cause - check
   `tenant_identity_providers.saml_certificate` against what the IdP
   currently publishes) or OIDC ID token verification failed (clock skew
   between this platform and the IdP is the most common cause here).
3. **`SSO_REQUEST_EXPIRED` (400)** - the user took more than 10 minutes on
   the IdP's login page, or RelayState/`state` was tampered with/lost. Ask
   them to restart from `GET /v1/auth/sso/login/:tenantIdpId`.
4. A failure the caller (browser) sees as a redirect to their own app with
   `?error=access_denied&error_description=...` is any of the above,
   surfaced through the client's `redirect_uri` instead of a JSON body
   (ADR-0031) - check this platform's own logs for the underlying
   `SsoAssertionInvalidError`/`SsoProviderUnavailableError`, not the
   client's error page.

## Phase 3 - SCIM deprovisioning didn't end an active session

Should not happen - `PATCH .../active:false` and `DELETE` both call
`RefreshTokenService.revokeAllSessionsForUser` synchronously before
returning. If a user's session outlives their deprovisioning:

1. Confirm the SCIM request actually landed: `SELECT status FROM core.users
   WHERE id = '<user_id>'` should already be `disabled`.
2. Check `core.refresh_tokens WHERE user_id = '<user_id>'` for any row still
   `status = 'active'` - if one exists, `revokeAllForUser`'s UPDATE didn't
   cover it (a family created *during* the revocation call, a race with a
   concurrent login, is the most likely cause - re-run the deprovisioning
   PATCH, which is idempotent).
3. An already-issued **access token** (up to 12 minutes old) is not
   individually revoked by this flow unless its `jti` is separately
   blacklisted - it expires naturally within that window regardless. If
   immediate access-token invalidation is required, that needs each active
   `jti` blacklisted via `TokenRevocationService.revoke`, which requires
   knowing them (not tracked per-user today - a gap noted in the readiness
   checklist).

## Phase 3 - Revoking/rotating a WebAuthn credential

A user's own passkey management: `GET /webauthn/credentials` (list),
`DELETE /webauthn/credentials/:id` (revoke one), both require that user's
own access token. There is no admin-initiated "revoke this user's passkey"
endpoint yet - an operator response to a suspected-compromised passkey today
is a direct `DELETE FROM core.webauthn_credentials WHERE id = '<id>'`, which
is safe (no cascading session impact - a passkey delete doesn't revoke
already-issued tokens, same as any other credential-type change).

## Phase 4 - Granting a tenant admin their first RBAC permissions

The seed script's `tenant_admin` system role already has every non-
`tenant:delete` permission bound (`src/database/seeds/run-seed.ts`), so a
seeded demo tenant needs no manual bootstrap. For a real, freshly-provisioned
tenant with no roles yet:

```bash
# 1. Create a tenant-scoped role
curl -X POST https://<host>/v1/roles -H "Authorization: Bearer <token>" \
  -d '{"name": "Tenant Administrator"}'

# 2. List the permission catalog to find the ids you need
curl https://<host>/v1/permissions -H "Authorization: Bearer <token>"

# 3. Bind permissions to the role
curl -X POST https://<host>/v1/roles/<roleId>/permissions \
  -H "Authorization: Bearer <token>" -d '{"permissionId": "<id>"}'

# 4. Assign the role to a user (tenant-wide - omit scopeOrgUnitId)
curl -X POST https://<host>/v1/users/<userId>/roles \
  -H "Authorization: Bearer <token>" -d '{"roleId": "<roleId>"}'
```

Every one of these calls itself requires `role:write`/`role:read` -
circular for a genuinely first tenant with zero roles. Production bootstrap
for a brand-new tenant needs either a platform-admin escape hatch (not built
- `ADR-0007`'s `app.is_platform_admin` GUC exists at the database layer but
nothing in the RBAC surface currently sets `@RequirePermissions` aside based
on it) or a seed-equivalent step run with elevated access at tenant
provisioning time. Flagged in the production readiness checklist.

## Phase 4 - Diagnosing an unexpected 403 on a Policy write

1. **Plain `Forbidden` (RBAC)** - the caller's JWT `permissions` claim
   doesn't include `policy:write` at all. Check their role assignments
   (`GET /v1/users/{id}/roles`) and each role's bound permissions
   (`GET /v1/roles/{id}/permissions`).
2. **`ABAC_SCOPE_DENIED`** - the caller holds `policy:write` but only via a
   role scoped to a *different* org unit than the one on the policy being
   written (or only tenant-wide when the write itself is fine, or vice
   versa - re-check `Policy.orgUnitId` on the request against
   `UserRole.scope_org_unit_id` on their assignments). Remember ADR-0036:
   scope matching is exact, not subtree-aware - a role scoped to a parent
   org unit does not cover this policy's org unit even if it's a
   descendant.
3. Access token more than a few minutes old and a role was *just* changed?
   `PermissionsGuard` reads the token's frozen claims, not a live lookup -
   the change took effect for the *next* token (ADR-0038), not the one
   already in hand. Re-authenticate (or `POST /oauth/token` with
   `grant_type=refresh_token`) to pick up the new permission set.

## Phase 5 - Diagnosing a missing `AuditEvent`/`PolicyChanged` in NATS

1. **Check `core.outbox_events` first**: `SELECT * FROM core.outbox_events
   WHERE tenant_id = '<id>' ORDER BY created_at DESC LIMIT 20`. If the row
   exists with `published_at IS NULL` and `attempts > 0`, NATS was/is
   unreachable - `CoreOutboxPublisherService` retries every 10 seconds;
   check `last_error` for the underlying connection failure.
2. **If `attempts >= 5`**, the event was routed to `agno.core.dlq.v1`
   instead (`published_at` will be set - "published" means "handled," not
   necessarily "delivered to the original subject"). Check DLQ consumers
   for it there.
3. **If no `core.outbox_events` row exists at all** for an audit action you
   expected to see: check `core.pending_audit_events` first (below) - the
   event may still be sitting in the durable queue, not yet flushed to
   `audit_log`. If it's in neither table, check ADR-0044's list of
   instrumented write paths - `introspect`, `GET /oauth/authorize`, and
   failed-login/failed-SSO paths are still deliberately not audited (see
   that ADR's consequences).
4. **JetStream "no stream matches subject" errors**: run `npm run
   nats:provision-streams` (ADR-0043) against the target environment's
   `NATS_URL` - it idempotently provisions `AGNO_CORE_AUDIT`/
   `AGNO_CORE_POLICY`/`AGNO_CORE_DLQ` (and Module 02's `AGNO_ORG_EVENTS`/
   `AGNO_ORG_DLQ`). This is a one-time-per-environment step, the same
   shape as `npm run migration:run` - not something app boot runs
   automatically, so a fresh environment that hasn't had it run yet will
   see exactly this error on first publish.

## Phase 5 - Diagnosing a missing or stuck row in `core.pending_audit_events`

`AuditEventBatcherService.enqueue` (used by `AuditService.RecordEvent`
gRPC and every fire-and-forget REST instrumentation point - OAuth, SSO,
SCIM, WebAuthn) durably inserts into `core.pending_audit_events`
(ADR-0042) before the 2-second flush tick moves it into `audit_log`.

1. **Row present with `attempts = 0`, been there more than a few seconds**:
   the flush tick isn't running - check the process's `@nestjs/schedule`
   is actually initialized (`ScheduleModule.forRoot()` in `app.module.ts`)
   and the process hasn't crashed. `SELECT * FROM core.pending_audit_events
   WHERE tenant_id = '<id>' ORDER BY created_at ASC` to see what's queued.
2. **Row present with `attempts > 0`**: `audit_log`'s write is failing -
   check `last_error` on the row. Once `attempts` reaches 3
   (`FLUSH_MAX_RETRIES`), the row is routed to `agno.core.dlq.v1` and
   deleted - check the DLQ subject/consumer for it there.
3. **Row present with `attempts` far above 3 and `last_error` mentioning
   "DLQ publish also failed"**: both `audit_log` writes and NATS are down
   simultaneously - the genuinely rare double-outage window ADR-0042's
   consequences section names as the honest remaining limit. The row is
   deliberately kept (not deleted) so it retries again every tick once
   either dependency recovers - this is expected behavior, not a bug.
4. **A row that should exist doesn't, and `enqueue` was definitely called**:
   check the enqueuing process's logs for `Failed to durably enqueue audit
   event` (ERROR level, full payload included) - the insert into
   `core.pending_audit_events` itself failed (Postgres unreachable at that
   moment). This is the one true loss window ADR-0042 does not close -
   everything after a successful `enqueue` is durable; the insert call
   itself is not retried.

## Phase 5 - Diagnosing an `AuditService.RecordEvent` gRPC call that returned `accepted: false`

- `errorCode: "AI_RATIONALE_REQUIRED"` - the request had
  `actor_type = "ai_agent"` with an empty/missing `ai_rationale_json`.
  §2.2 rule 3 - fix the caller, not this service.
- `errorCode: "INVALID_REQUEST"` - malformed JSON in one of the
  `*_json` fields, or another validation failure the handler caught.
  Check `AuditGrpcController`'s own logs for the underlying error message.
- A `RecordEvent` call that returns `accepted: true` means the event has
  been durably inserted into `core.pending_audit_events` (ADR-0042) - not
  yet written to `audit_log` (that happens on the next 2-second flush
  tick), but a process restart between `accepted: true` and that tick no
  longer loses it, unlike the original Phase 5 design. The one remaining
  loss window is the insert itself failing (Postgres unreachable at the
  exact moment `enqueue` runs) - see the durable-queue troubleshooting
  section above.

## Phase 6 - Diagnosing a webhook subscription that isn't receiving events

1. **Check `core.webhook_deliveries` first**: `SELECT * FROM
   core.webhook_deliveries WHERE subscription_id = '<id>' ORDER BY
   created_at DESC LIMIT 20`. No rows at all means fan-out never enqueued
   anything for this subscription - check `subscribedSubjects` on the
   subscription actually includes the subject you expected
   (`agno.core.audit.created.v1`/`agno.core.policy.changed.v1` are the only
   two eligible right now, ADR-0046) and that `is_active = true`.
2. **Rows exist with `status = 'pending'` and `attempts = 0`, been there
   more than a few seconds**: the dispatcher's 5-second tick isn't
   running - check the process's `@nestjs/schedule` initialized correctly
   and hasn't crashed.
3. **Rows with `attempts > 0` and `status = 'pending'`**: delivery is
   failing - check `last_error` (an `HTTP <status>` from the receiver, or a
   network-level error message). Once `attempts` reaches 5, the row moves
   to `status = 'dead_lettered'` and stops retrying.
4. **`status = 'dead_lettered'` with `last_error = 'subscription deleted
   or deactivated since enqueue'`**: the subscription was deleted/deactivated
   after the event was already queued for it - expected behavior, not a bug.
5. **Receiver claims the signature doesn't verify**: confirm they're
   computing HMAC-SHA256 over `${timestamp}.${rawBody}` (both pulled from
   the `x-agno-webhook-signature: t=<timestamp>,v1=<hmac>` header and the
   exact raw request body bytes, not a re-serialized/re-parsed version of
   it) using the subscription's `secret` - re-serialization (different key
   ordering, whitespace) is the most common cause of a receiver-side
   mismatch even when the secret itself is correct.

## Phase 6 - Diagnosing a `409 Conflict` on a POST/PUT/PATCH/DELETE request

The caller sent an `Idempotency-Key` header whose value is already
"in flight" per `IdempotencyInterceptor` (ADR-0047) -
`redis-cli GET idempotency:<tenantId>:<key>:lock` will show a value if so.
This clears automatically within 30 seconds (`IN_FLIGHT_LOCK_TTL_SECONDS`)
even if the original request never completed (crashed mid-handler) - if a
caller is stuck in a retry loop hitting this repeatedly, check whether
their *first* request with that key actually completed
(`redis-cli GET idempotency:<tenantId>:<key>` - a hit means it did, and
the 409 was a genuine concurrent double-send on their end, not a stuck
lock).

## Phase 7 - Observability quick reference

- **`GET /healthz`** - liveness only, no dependency checks, always 200 if the
  process is alive. Point an orchestrator's liveness probe here, never at
  `/readyz` (a Postgres outage should not make an orchestrator kill and
  restart otherwise-healthy instances - that turns a dependency outage into
  a self-inflicted capacity outage on top of it).
- **`GET /readyz`** - readiness. 503 only if Postgres is unreachable; a
  down Redis is reported (`redis: "unreachable"`) but does not fail
  readiness (§1: Redis is cache-only, every Redis-touching service already
  fails open to Postgres).
- **`GET /metrics`** - Prometheus text exposition (`MetricsController`,
  ADR-0050). `docker-compose up -d prometheus grafana` gives a working
  local dashboard (`observability/grafana-dashboard.json`, pre-provisioned)
  at `http://localhost:3001` (admin/admin).
- **Traces** - set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g.
  `http://localhost:4318`) before starting the app to ship spans to a real
  OTLP collector (Tempo/Jaeger/a vendor collector); unset, spans are still
  generated in-process but never exported anywhere (`src/tracing.ts`).

## Phase 7 - Chaos / game-day exercises

Each scenario below has already been engineered a specific degraded-mode
behavior into this codebase - a game-day exercise's job is to *verify* that
behavior actually holds under a real failure injection, not to discover it
for the first time during a real incident. Run these against a non-production
environment only.

1. **Kill Postgres mid-traffic.** Expected: `/readyz` flips to 503 within
   one health-check interval; every in-flight `TenantScopedRepository` call
   fails loudly (no silent data loss - Postgres is this platform's only
   system of record); `/healthz` stays 200 the whole time (the process
   itself is fine). Recovery: bring Postgres back - no manual intervention
   needed, `TypeOrmModule`'s connection pool reconnects on its own.
2. **Kill Redis mid-traffic.** Expected: `/readyz` reports
   `redis: "unreachable"` but stays 200 overall; `UserContextCacheService`/
   `RefreshTokenService`/`TokenRevocationService` fall through to Postgres
   (higher latency, same correctness); `IdempotencyInterceptor` fails open
   (dedup/locking stops working, requests still succeed - ADR-0047). Verify:
   latency (`http_request_duration_seconds` p99) rises but the error rate
   does not.
3. **Kill NATS mid-traffic.** Expected: `core.outbox_events`/
   `core.pending_audit_events` rows keep accumulating (`published_at IS
   NULL`/rows simply not yet processed) - `core_outbox_events_unpublished`/
   `core_pending_audit_events` gauges climb on the dashboard, `attempts`
   increments on affected rows, nothing is lost. Recovery: bring NATS back -
   `CoreOutboxPublisherService`/`AuditEventBatcherService` drain the backlog
   automatically on their next tick, no manual replay needed (unless a row
   already hit its dead-letter threshold while NATS was down, per
   ADR-0039/ADR-0042/ADR-0046's own retry ceilings).
4. **Kill the app process itself (SIGKILL, not SIGTERM) mid-flush.**
   Expected: whatever `AuditEventBatcherService.onModuleDestroy`'s graceful
   drain would have caught is instead caught by the *durable queue itself*
   (`core.pending_audit_events`, ADR-0042) - a replacement process's next
   flush tick picks up exactly where the killed one left off. This is the
   scenario `test/integration/durable-audit-queue.spec.ts`'s "simulated
   process restart" test exists to prove outside of a live game day too.
5. **Revoke/corrupt the active signing key mid-traffic.** Expected: new
   `POST /oauth/token` calls fail (no valid key to sign with) but existing
   already-issued access tokens keep verifying until their natural
   12-minute expiry (`SigningKeyService`'s retirement grace window doesn't
   apply here - this is simulating the active key itself becoming
   unusable, not a rotation). Recovery: `signingKeyService.rotate()`
   (`docs/runbook.md`'s own Phase 2 section) issues a new active key;
   token issuance resumes immediately.
6. **Forge an `X-Tenant-Id` header while holding a valid JWT for a
   different tenant, against an RBAC-gated endpoint.** Expected (post
   ADR-0049): the request executes against the *JWT's own* `tenant_id`,
   never the forged header - this is the specific regression
   `test/unit/tenant-context.middleware.spec.ts`'s first test case exists
   to catch. A game day should periodically re-verify this by hand against
   a real running instance, not rely on the unit test alone.

## Incident postmortem template

Copy this section into a new doc (or an incident-tracking tool) per
incident - filling in every field, including "N/A" where genuinely not
applicable, is the point: a blank field is a question nobody asked yet.

```markdown
# Incident: <short title>

**Severity:** SEV-1 / SEV-2 / SEV-3
**Detected:** <timestamp, UTC> via <alert name / user report / other>
**Declared:** <timestamp incident response formally started>
**Resolved:** <timestamp service restored>
**Duration:** <resolved - detected>

## Impact
- Which tenant(s)/endpoint(s)/SLO(s) were affected (§0.5 targets, this
  runbook's "Observability quick reference" section above).
- Request volume/error rate during the window (`http_requests_total`,
  Grafana dashboard).
- Any data integrity concern (did anything land in `audit_log` incorrectly,
  did any event get lost past its documented retry/DLQ ceiling, ...).

## Timeline (UTC)
- `HH:MM` - <what happened / was observed / was done>
- `HH:MM` - <...>

## Root cause
What actually broke, one level deeper than "the symptom" - not "Postgres
was slow" but *why* it was slow.

## Detection
How was this actually found - an alert, `/readyz` failing, a user report?
If not an alert: what metric/threshold *should* have caught it, and why
didn't it (missing panel, no alert rule, threshold too loose)?

## Resolution
What action actually fixed it. Link the specific runbook section used, if
any - and if none existed for this scenario, that's an action item to add
one.

## Action items
| Action | Owner | Ticket | Due |
|---|---|---|---|
| | | | |

## What went well / what didn't
Two short lists - this is the section people skip under time pressure and
the one that actually prevents a repeat.
```
