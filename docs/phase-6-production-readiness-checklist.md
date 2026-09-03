# Phase 6 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `/v1/tenants` REST CRUD (`TenantManagementController`) - `self`/`:id`/
      list-children/create/update, RBAC-gated (`tenant:read`/`tenant:write`),
      audit-instrumented.
- [x] Read-only GraphQL BFF (`PlatformGraphQLModule`, ADR-0045) -
      `tenant`/`myTenant`/`tenantChildren`, `me`/`user`/`users` (+ `roles`
      field), `role`/`roles`/`permissions` (+ `permissions` field),
      `policy`/`policyHistory`/`policies`, `auditLog`. Same RBAC guards as
      REST (`AccessTokenGuard`/`PermissionsGuard`, now GraphQL-aware).
- [x] Webhook subscription CRUD (`/v1/webhooks`, secret returned once) +
      durable delivery queue (`core.webhook_deliveries`, HMAC-SHA256
      signed, retry-then-dead-letter) fed from `CoreOutboxPublisherService`'s
      existing drain loop (ADR-0046).
- [x] `Idempotency-Key` support (`IdempotencyInterceptor`, global,
      opt-in, Redis-backed) for REST POST/PUT/PATCH/DELETE (ADR-0047).
- [x] Envoy gateway config (`envoy/envoy.yaml`, docker-compose `envoy`
      service) - REST/GraphQL + gRPC listeners, coarse `local_ratelimit`
      safety net (ADR-0048).
- [x] Unit tests (`WebhookDeliveryDispatcherService`'s signing/retry/dead-letter
      logic, `IdempotencyInterceptor`'s cache-replay/lock/pass-through
      paths) and integration tests (`WebhookFanoutService`'s subject-matching
      and active/inactive filtering against real Postgres RLS).

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **GraphQL mutations for Module 01's own domain.** ADR-0045's explicit
      scope cut - REST remains the only way to create/update a tenant,
      role, policy, or webhook subscription. A GraphQL client must call
      the REST endpoint for any write.
- [ ] **Per-tenant rate limiting.** `PolicyType.RATE_LIMIT` policies can
      already be created/read (REST + GraphQL), but nothing enforces them.
      Envoy's `local_ratelimit` filter is a coarse, per-instance, tenant-
      unaware safety net only. Real per-tenant enforcement needs an
      external Envoy Rate Limit Service (`envoy.filters.http.ratelimit` +
      a gRPC service implementing `envoy.service.ratelimit.v3.RateLimitService`
      that reads `core.policies WHERE policy_type = 'rate_limit'`) - a
      separate, sizeable piece of infrastructure work, not built this
      phase (ADR-0048).
- [ ] **Webhook secret encryption at rest.** `core.webhook_subscriptions.secret`
      is plaintext in Postgres - a production deployment needs KMS-backed
      envelope encryption on this column, the same flagged (and still
      open) gap ADR-0024 already carries for signing-key private key
      storage. Not solved here or there.
- [ ] **Webhook fan-out for Module 02's `org.*` events.** Only
      `agno.core.audit.created.v1`/`agno.core.policy.changed.v1` are
      fan-out-eligible; `EmployeeChanged`/`SkillExpiring` are not (ADR-0046).
- [ ] **A live NATS broker / real webhook receiver was not available in
      this environment.** `WebhookDeliveryDispatcherService`'s HTTP POST +
      signing logic is unit-tested against a mocked `fetch`; the durable-
      queue write (the correctness-critical half) is integration-tested
      against real Postgres. End-to-end delivery to a live receiver is
      unverified here - same posture as every other NATS-adjacent gap in
      this repo (ADR-0019/ADR-0043).
- [ ] **Envoy config is unexercised.** `envoy/envoy.yaml` is written and
      believed correct against Envoy's v3 API surface, but this
      environment has no way to actually run Envoy and send a request
      through it - not smoke-tested end to end.
- [ ] **mTLS, autodiscovery, and other production hardening for Envoy**
      (ADR-0048) - `docker-compose.yml`'s own "local development only"
      scope applies to `envoy/envoy.yaml` too.
- [ ] **A consumer-facing API documentation surface** (OpenAPI spec,
      GraphQL schema docs site, webhook payload/signature-verification
      guide for integrators) - none of this phase's new surfaces are
      documented anywhere an external integrator could find them; this
      design doc and the code's own doc comments are the only reference
      today.
- [ ] **Load testing** for the GraphQL BFF, webhook delivery dispatcher,
      and Idempotency-Key's Redis-backed cache under real request volume -
      no measurement exists.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Same explicit
      non-goal as every previous phase (§9 of the source spec).
