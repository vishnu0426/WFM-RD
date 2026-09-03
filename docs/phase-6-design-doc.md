# Phase 6 Design Doc — External API Surface (GraphQL BFF, Webhooks, Idempotency, Envoy Gateway)

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 6 — `/v1/tenants` REST CRUD, a read-only GraphQL BFF
over Module 01's own domain, webhook subscription + delivery (§3.2's
signing-secret posture), the `Idempotency-Key` cross-cutting REST
requirement, and an Envoy gateway config. Depends on every prior phase's
REST/RBAC/audit infrastructure already existing.

## Problem

By the end of Phase 5, Module 01 had a real REST surface for OAuth/SSO/
SCIM/WebAuthn/RBAC/Policy/Audit, but three things §3.2/§1 name were still
missing entirely: (1) `Tenant` - the root entity of this whole platform -
had no REST surface of its own, only fixture/seed writes; (2) no GraphQL
BFF existed for Module 01's own domain (Module 02 already has one for
org/employee data); (3) nothing let an external system subscribe to this
platform's events over HTTP (`GET /v1/audit-log` and NATS are both
pull/subscribe, not push); (4) the `Idempotency-Key` cross-cutting
requirement, deferred by name in ADR-0020/ADR-0025/Phase 2's own design
doc, had no implementation anywhere; (5) §1's Envoy gateway requirement had
no config of any kind.

## Decision

**`/v1/tenants`** (`TenantManagementController`, `TenantApiModule`):
`GET .../self`, `GET .../:id`, `GET .../ ?parentTenantId=`, `POST`, `PUT` -
a thin REST layer over `TenantsRepository` (which already existed since
Phase 1), gated by the `tenant:read`/`tenant:write` permissions
`TenantIdentityProvidersController` already established, with the same
synchronous `AuditLogRepository.record` instrumentation as every other
admin-CRUD controller in this repo. No hard delete (`TenantsRepository`
has none - tenants are deprovisioned via `status`).

**GraphQL BFF** (`PlatformGraphQLModule`, ADR-0045): read-only queries -
`tenant`/`myTenant`/`tenantChildren`, `me`/`user`/`users`, `role`/`roles`/
`permissions`, `policy`/`policyHistory`/`policies`, `auditLog` - each
delegating to the exact service/repository its REST equivalent already
uses. `AccessTokenGuard`/`PermissionsGuard` were extended to read from
`GqlExecutionContext` when running under Apollo, so both surfaces enforce
RBAC identically rather than maintaining two copies.

**Webhooks** (`WebhookModule`/`WebhookApiModule`, ADR-0046):
`core.webhook_subscriptions` (admin CRUD, `/v1/webhooks`, secret returned
once) + `core.webhook_deliveries` (a durable queue, same shape as
`core.pending_audit_events`/`core.outbox_events`, drained every 5s by
`WebhookDeliveryDispatcherService`). `CoreOutboxPublisherService` calls
`WebhookFanoutService.fanOut` immediately after a successful NATS publish,
so webhook delivery inherits the outbox's own cadence rather than running
a second independent poll over the same source table. HMAC-SHA256 signing
follows Stripe's `t=<ts>,v1=<hmac>` shape (timestamp included in the signed
material, not just the body, so replay can be detected receiver-side).

**`Idempotency-Key`** (`IdempotencyInterceptor`, ADR-0047): a single global
`APP_INTERCEPTOR`, opt-in (no header = unchanged behavior), Redis-backed
(`RedisService.setIfNotExists`, newly added, for the atomic in-flight
lock), REST-only.

**Envoy gateway** (`envoy/envoy.yaml`, ADR-0048): two listeners (REST/
GraphQL on 8080, gRPC on 8081), a coarse `local_ratelimit` safety net. The
per-tenant `PolicyType.RATE_LIMIT`-driven quota §3.4 actually describes
needs an external Rate Limit Service this phase does not build - see
ADR-0048's consequences.

## Blast radius

- Two new tables (`core.webhook_subscriptions`, `core.webhook_deliveries`),
  additive.
- `CoreOutboxPublisherService`'s constructor gained a new dependency
  (`WebhookFanoutService`) and its `drain` loop gained one new call after
  each successful publish - existing outbox publish/retry/DLQ behavior is
  unchanged; a webhook fan-out failure is caught inside `fanOut` itself and
  never affects the outbox row's own bookkeeping.
- `AccessTokenGuard`/`PermissionsGuard` gained a `getRequest` branch for
  GraphQL contexts - the REST branch (`switchToHttp().getRequest()`) is
  byte-for-byte unchanged, so every existing REST caller of these guards is
  unaffected.
- `IdempotencyInterceptor` is a new global interceptor - a no-op for any
  request that doesn't send `Idempotency-Key`, which is every existing
  caller today (no client in this repo's own test suite sends the header).
- `WebhookSubscriptionsController`'s `create` DTO validates `subscribedSubjects`
  against a fixed allow-list (`SUBJECTS.AUDIT_CREATED`/`SUBJECTS.POLICY_CHANGED`)
  - adding a new subscribable subject later means updating that allow-list,
  not a schema change.

## Rollback plan

Additive throughout - reverting means removing `TenantApiModule`/
`WebhookApiModule`/`PlatformGraphQLModule` from `app.module.ts`, reverting
`CoreOutboxPublisherService`'s constructor/drain-loop change, removing the
`IdempotencyInterceptor` `APP_INTERCEPTOR` registration, and dropping
`envoy/envoy.yaml`/the docker-compose `envoy` service (no application code
depends on Envoy actually running - it's a gateway in front of the app, not
a dependency of it). The migration's `down()` drops both webhook tables.
`AccessTokenGuard`/`PermissionsGuard`'s GraphQL branch is the one
non-trivially-revertible piece (removing it breaks every GraphQL resolver
added this phase) - reverting it means reverting `PlatformGraphQLModule`
in the same change.

## Explicit assumptions (spec was ambiguous or silent here)

1. **GraphQL BFF is read-only for Module 01's own domain this phase** - see
   ADR-0045.
2. **Webhook `secret` is stored plaintext**, not hashed - see ADR-0046's
   reasoning (this platform must read it back to sign every delivery).
3. **Webhook fan-out is scoped to `core.*` subjects only** - Module 02's
   `org.*` events are not wired to fan-out (ADR-0046's explicit cut).
4. **`Idempotency-Key` is REST-only, opt-in** - GraphQL mutations aren't
   covered (there are none yet, per assumption 1 above, so this is
   currently moot but will need revisiting if GraphQL mutations are added).
5. **Envoy's rate limiting is a coarse, per-instance safety net only** -
   the per-tenant `PolicyType.RATE_LIMIT`-driven quota §3.4 describes is
   explicitly deferred (ADR-0048), not approximated by the coarse limiter.
6. **A new `webhook` resource was added to the permission catalog**
   (`webhook:read`/`webhook:write`) - same extensibility pattern as every
   earlier phase's new resource.

## Out of scope for this phase (do not build yet)

- GraphQL mutations for Module 01's domain (ADR-0045).
- An external Envoy Rate Limit Service reading `PolicyType.RATE_LIMIT`
  policies (ADR-0048) - the data model and CRUD for these policies already
  exist; only the enforcement service is deferred.
- Webhook fan-out for Module 02's `org.*` subjects (ADR-0046).
- mTLS/autodiscovery/production hardening for the Envoy config
  (ADR-0048) - `docker-compose.yml`'s own stated "local development only"
  scope applies here too.
- A consumer-facing API documentation surface (OpenAPI/GraphQL schema
  docs site) describing any of this to external integrators - no such
  surface exists anywhere in this repo yet.
