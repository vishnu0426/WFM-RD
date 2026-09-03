# Module 12 Phase 8 Design Doc — Integration Hub: RBAC + Connector Health Dashboard

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12).
**Scope:** Per §7 — connector health dashboard, observability, and hardening: the module's final phase. Concretely: real RBAC (`AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`, ADR-0145) gating the two credential-adjacent mutations, the `connectorHealth`/`connectorsHealth` aggregating GraphQL queries, `integration_hub_rbac_denials_total`/`integration_hub_webhook_deliveries_total` metrics, and a module-wide production readiness checklist closing out all eight phases.

## Problem

This module's every prior phase left every query/mutation on the same header-trust placeholder (ADR-0014) every other pre-RBAC-phase module in this platform starts with. Two real questions had to be answered before writing code, not discovered mid-implementation:

1. **What RBAC mechanism actually exists to reuse?** ai-layer-service's own ADR-0130/0133 already answered this for a genuinely separate deployable service (remote JWKS against core's real OIDC issuer) - the only real question left was *which* of this module's own mutations carry the specific kind of risk ai-layer-service's own scoping logic (gate the credential/autonomy-controlling writes, not everything) would flag.
2. **What does "connector health dashboard" mean for a backend module with no frontend anywhere in this repo?** Every other module's own "dashboard" phase (where one exists) turned out to mean the same thing: a real aggregating read query a UI would call, not a new subsystem.

## Decision

**RBAC** (ADR-0145): own copies of ai-layer-service's full guard trio, unchanged in shape - `AccessTokenGuard` (remote JWKS via `jose`'s `createRemoteJWKSet`, `CORE_JWKS_URI`/`OIDC_ISSUER`/`OIDC_AUDIENCE`), `PermissionsGuard` (`@RequirePermissions(...)` against the JWT's flat `permissions` claim), `TenantTokenMatchGuard` (cross-checks the JWT's own `tenant_id` claim against `TenantContextService`'s header-derived tenant - without it, a valid token for tenant A holding the right permission would still pass `PermissionsGuard` against a spoofed `x-tenant-id: B` header). `createConnector` (`integration_connector:write`) and `createWebhookSubscription` (`webhook_subscription:write`) are gated - the two mutations in this module's entire schema that produce a real credential or a real signing secret. Both resources registered in core's own `run-seed.ts` `RESOURCES` array so the permission strings are real, grantable things, automatically inherited by `platform_admin`/`tenant_admin` through that file's existing generic role-binding logic - no special-casing needed.

**Connector health dashboard** (`ConnectorHealthResolver`) - `connectorHealth(connectorId)`/`connectorsHealth` aggregate `IntegrationConnector`'s own `status`/`lastSyncAt`/`lastSyncStatus`, its 5 most recent `SyncJob` rows, and (for `acd` connectors only) whether its latest streaming `SyncJob` is currently `running` - built entirely from data every prior phase already made real, no new table, no new write path.

**Observability**: `integration_hub_rbac_denials_total{reason}` closes the exact gap ai-layer-service's own ADR-0130 disclosed and left open for itself ("Guards run before `HttpMetricsInterceptor`... no counter anywhere for RBAC denials") - closed here from the start rather than repeated as a first-disclosed-then-later-fixed gap. `integration_hub_webhook_deliveries_total{outcome}` is the metrics-visible counterpart to each `WebhookDelivery` row's own `retryCount`/`deliveredAt`.

## Verification

**Real end-to-end** (`test/integration/rbac.spec.ts`, 7 tests): a real local HTTP server serving a real JWKS (a freshly generated RSA keypair, `jose.exportJWK`), real signed JWTs (`jose.SignJWT`) exercising every scenario ADR-0130 itself established - valid token + correct permission + matching tenant → all three guards pass; missing Authorization header → `AccessTokenGuard` rejects; wrong signing key → rejects; expired token → rejects; missing permission → `PermissionsGuard` rejects; an ungated handler passes any token through unchecked; spoofed tenant → `TenantTokenMatchGuard` rejects. Each guard's actual `canActivate` method is called directly against a hand-built `ExecutionContext` exposing exactly the methods each guard reads - not a reimplementation, not a mock of the guard logic itself.

**Connector health** (`test/integration/connector-health.spec.ts`, 3 tests, real Postgres + real Vault): a batch connector's real sync history (two real `SyncJobsService.complete()` calls, one success one failure) comes back most-recent-first with `hasActiveStreamingSession: false`; a streaming connector with a real `running` `SyncJob` reports `hasActiveStreamingSession: true`; `connectorsHealth` aggregates both; an unknown `connectorId` surfaces the real `ConnectorNotFoundError`.

**Full suite**: 61 unit tests (unchanged) + 51 integration tests (up from 41), `typecheck`/`lint` clean.

## Blast radius

- New: `src/auth/**` (`access-token.guard.ts`, `permissions.guard.ts`, `require-permissions.decorator.ts`, `current-token-claims.decorator.ts`, `tenant-token-match.guard.ts`, `auth.module.ts`), `src/connectors/graphql/connector-health.resolver.ts`, `test/integration/{rbac,connector-health}.spec.ts`. New ADR-0145, this doc, `docs/module-12-production-readiness-checklist.md` (module-wide, closing all eight phases).
- Modified: `src/connectors/graphql/integration-connector.resolver.ts`/`src/webhooks/graphql/webhook-subscription.resolver.ts` (guards added to their one gated mutation each), `src/graphql/graphql.module.ts`/`src/webhooks/webhooks.module.ts` (import `AuthModule`), `src/common/metrics/metrics.service.ts` (two new counters), `src/webhooks/webhook-delivery-dispatcher.service.ts` (records the new delivery-outcome metric). `package.json` (`jose` added, matching ai-layer-service's pinned `^5.10.0`). Root repo's `src/database/seeds/run-seed.ts` (`RESOURCES` array gained `integration_connector`/`webhook_subscription`).
- No change to any Module 12 entity's schema.

## Rollback plan

Revert this phase's commits, including the two `@UseGuards`/`@RequirePermissions` additions and `AuthModule`'s import into `graphql.module.ts`/`webhooks.module.ts`. `createConnector`/`createWebhookSubscription` fall back to the header-trust placeholder every other mutation in this schema already runs on. `connectorHealth`/`connectorsHealth` are purely additive queries - removing them affects nothing else. Root repo's `run-seed.ts` resource registration is additive and backward-compatible (existing seeded environments simply don't have the two new permissions granted until reseeded).

## Explicit assumptions (spec was ambiguous or silent here)

1. **Only `createConnector`/`createWebhookSubscription` are RBAC-gated** - the same "gate the specific escalating risk, not everything" scoping ai-layer-service's own ADR-0130 applied to its first two gated mutations. Not a claim the rest are unimportant; a real, explicit, disclosed scope boundary (production readiness checklist).
2. **"Connector health dashboard" means a real aggregating query, not a new frontend or a new subsystem** - this module (like ai-layer-service, like Module 01) has no dashboard UI anywhere in this repo for a literal dashboard to exist in.
3. **`ConnectorHealthResolver` is called directly in its own test, not through a full Nest HTTP bootstrap** - the same pattern every other resolver test in this suite already uses; no test anywhere in this repo spins up `supertest` against a running app.

## Out of scope for this phase (do not build yet)

- RBAC expansion beyond the two gated mutations - a future, separate scope decision.
- Per-tenant write-frequency rate limiting on GraphQL mutations (production readiness checklist's own open item).
- A shared (Redis-backed) rate-limiter store for multi-instance deployment (ADR-0140, still open).
- Avaya (ADR-0142), ADP's real mTLS handshake (ADR-0143) - both still open from Phase 6b.

This is §7's final phase for Module 12 - remaining open items are recorded in `docs/module-12-production-readiness-checklist.md`, not deferred to an unnamed future phase within this module's own build sequence.
