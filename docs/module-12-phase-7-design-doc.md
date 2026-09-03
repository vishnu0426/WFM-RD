# Module 12 Phase 7 Design Doc — Integration Hub: Webhook Framework

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12).
**Scope:** Per §7 — `WebhookSubscription`/`WebhookDelivery` CRUD, signing, retry/backoff, auto-disable, and the outbound NATS-driven dispatcher. Concretely: `WebhookSubscriptionsService`/`WebhookDeliveriesService` (Phase 1's already-migrated tables, first real code against them), `WebhookFanoutService`/`WebhookDeliveryDispatcherService` (ADR-0144's own copy of Module 01's ADR-0046 shape), a real `IntegrationHubNatsClientService` publishing `agno.integration_hub.sync_job.completed.v1`, and the remaining §3.1 GraphQL surface (`createWebhookSubscription`, `testWebhook`, `webhookDeliveries`, `triggerManualSync`, plus `webhookSubscriptions`).

## Problem

Every prior phase built this module's *inbound* real-time/batch integration surface (ingesting from HRIS/payroll/CRM/ACD providers). Phase 7 is the first *outbound* surface aimed at a tenant's own systems: "notify me when something in Integration Hub happens." Three real design questions had no answer sitting in this module's own prior phases:

1. **What triggers a delivery?** No event bus existed in this service at all before this phase - no NATS client, no domain-event concept beyond a `SyncJob` row's own status column.
2. **How is the signing secret stored?** §2.1's schema already answers this differently from Module 01's own precedent (`secret_reference`, not `secret`) - Phase 1's migration made the Vault-reference choice before any code existed to act on it.
3. **What does "give up on a subscription" mean**, given `WebhookSubscription.status`/`consecutive_failure_count` exist but no code yet interpreted them, and `WebhookDelivery` has no terminal-status column to write a "dead lettered" state into.

## Decision

**`SyncJobsService.complete()`** (ADR-0144) is the trigger - every real `SyncJob` completion, batch or streaming, already funnels through this one method; extended to publish `agno.integration_hub.sync_job.completed.v1` (a real, newly-provisioned `AGNO_INTEGRATION_HUB_EVENTS` JetStream stream, `scripts/provision-nats-streams.ts`) and immediately call `WebhookFanoutService.fanOut(tenantId, 'sync_job.completed', payload)` - both best-effort, caught and logged, never able to fail the actually-durable `SyncJob` write.

**`WebhookSubscriptionsService`** - `create()` generates a random secret, writes it to Vault (`integration-hub/{tenantId}/webhook/{id}/secret`), stores only the reference, returns the raw secret exactly once. `recordDeliveryOutcome()` is the auto-disable state machine: `FAILING_THRESHOLD = 5` consecutive failures flags `status: failing` (still attempted); `DISABLED_THRESHOLD = 20` sets `status: disabled` (excluded from all future fan-out and from any already-queued delivery `WebhookDeliveryDispatcherService` hasn't yet attempted); a single success resets the counter and self-heals `failing` back to `active`.

**`WebhookDeliveriesService`** - `enqueue()`/`findAllForSubscription()` are tenant-scoped (`withTenantConnection`, normal RLS path); `findPendingBatch()` is cross-tenant by design (own copy of `BatchSyncRunnerService.findDueConnectors`'s doc comment - a dispatcher tick scans every tenant's pending deliveries), reading via the migrator pool, filtered to `delivered_at IS NULL AND retry_count < 5` - dead-lettering is implicit in that filter, since `WebhookDelivery` has no status column to write a terminal state into.

**`WebhookDeliveryDispatcherService`** - a 5-second `@Cron` tick (own copy of Module 01's `WebhookDeliveryDispatcherService`, ADR-0046), reads the signing secret from Vault fresh on every attempt (never cached), signs `t=<unix_ms>,v1=<hmac>` over `${timestamp}.${rawBody}` (the same HMAC convention this module already uses for its outbound call to Module 05, `IntradayActivityEventClient` - one signing scheme used consistently everywhere this module signs an outbound request), POSTs with `x-agno-webhook-id`/`x-agno-webhook-event-type`/`x-agno-webhook-signature` headers, and on any non-2xx or network failure calls `recordFailure` + `recordDeliveryOutcome(delivered: false)`. Skips (without an HTTP call) any already-`disabled` subscription's still-pending delivery, still incrementing that row's own `retry_count` so it doesn't get reprocessed by every future tick forever.

**GraphQL** (`WebhookSubscriptionResolver`, `SyncJobHistoryResolver` extended): `createWebhookSubscription`, `testWebhook` (enqueues a real synthetic delivery through the same dispatcher path, not a direct un-queued call), `webhookDeliveries`, `triggerManualSync` (the GraphQL counterpart to the existing REST endpoint, same underlying `BatchSyncRunnerService` call), and `webhookSubscriptions` (a disclosed addition beyond the literal deferred-item list, ADR-0144).

## Verification

**Real end-to-end** (`test/integration/webhook-delivery.spec.ts`, real Postgres + real Vault + real NATS + a real local HTTP receiver):
- A real `SyncJob` completion (via `syncJobs.complete()`, not a shortcut) publishes to the real, provisioned NATS subject - confirmed by a real subscriber actually receiving the message, not by asserting `natsClient.publish` was called. The subsequent dispatcher tick delivers a real HTTP request to the real receiver, which independently recomputes the HMAC from the secret returned at subscription-creation time and confirms it matches - proof the dispatcher signs correctly, not just that it POSTs.
- A subscription pointed at a receiver that always 500s crosses both `FAILING_THRESHOLD` and `DISABLED_THRESHOLD` under real repeated delivery attempts, ending in real `status: disabled`; one more fan-out call afterward produces no new delivery row, proving the exclusion is real, not just documented.
- `testWebhook`'s own path (enqueue + dispatcher tick) genuinely delivers.

**Regression**: this phase's real bug, found and fixed before any of the above ran clean - an undrained `IntegrationHubNatsClientService` connection left the Jest process alive after every test had already finished (same hang class as Phase 6's WebSocket cleanup bug, different transport). Fixed with a tracked-and-closed connection list in a shared test helper (`test/integration/helpers/real-sync-jobs-service.ts`), used by all 11 pre-existing integration test files that construct a real `SyncJobsService` (now requiring the two new Phase 7 dependencies).

**Full suite**: 61 unit tests (unchanged - no new pure-logic module) + 41 integration tests (up from 38), `typecheck`/`lint` clean.

## Blast radius

- New: `src/webhooks/**` (`webhook-subscriptions.service.ts`, `webhook-deliveries.service.ts`, `webhook-fanout.service.ts`, `webhook-delivery-dispatcher.service.ts`, `nats/integration-hub-nats-client.service.ts`, `nats/integration-hub-nats.module.ts`, `graphql/{types,webhook-subscription.resolver}.ts`, `errors/webhook-subscription-not-found.error.ts`, `webhooks.module.ts`), `test/integration/webhook-delivery.spec.ts`, `test/integration/helpers/real-sync-jobs-service.ts`. New ADR-0144 and this doc. `scripts/provision-nats-streams.ts` (repo root) gained `AGNO_INTEGRATION_HUB_EVENTS`/`AGNO_INTEGRATION_HUB_DLQ`.
- Modified: `src/sync/sync-jobs.service.ts` (`complete()` now publishes + fans out; constructor gained two required dependencies - a real ripple into every test file that constructed it directly), `src/sync/sync.module.ts`/`src/graphql/graphql.module.ts` (import `WebhooksModule`), `src/connectors/graphql/sync-job-history.resolver.ts` (`triggerManualSync` mutation added). `package.json` (`nats` added, matching every sibling service's pinned `^2.29.3`).
- No change to any Module 12 entity's schema - Phase 1's `WebhookSubscription`/`WebhookDelivery` tables already had every column this phase needed.
- Environment: this session's local Vault switched from the external instance (`192.168.8.177`, VPN-gated) to a local dev-mode instance after the VPN dropped mid-phase and hung a full test run (`VaultClientService`'s `fetch` calls have no timeout) - `.env` updated accordingly, own doc comment explains why.

## Rollback plan

Revert this phase's commits, including `SyncJobsService.complete()`'s NATS-publish/fan-out addition and its constructor signature change (and, transitively, every test file's updated construction). `WebhooksModule` un-imported from `SyncModule`/`IntegrationHubGraphQLModule`. No other phase's code depends on this one - `BatchSyncRunnerService`/`StreamingRelayService` call `syncJobs.complete()` exactly as before, oblivious to what it does internally.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`SyncJobsService.complete()` is the fan-out trigger, not a new event emitted per-adapter or per-provider** - the only "something happened" moment common to every connector shape this module supports, matching ADR-0144's own reasoning.
2. **The webhook secret is Vault-referenced, not plaintext** (ADR-0144) - a real, disclosed deviation from Module 01's own precedent, justified by this module's own §0 attack-surface framing.
3. **`FAILING_THRESHOLD`/`DISABLED_THRESHOLD` (5/20) are this phase's own chosen constants** - no §2.1/§3 text names specific numbers; 5 matches Module 01's own `MAX_ATTEMPTS_BEFORE_DEAD_LETTER` for the per-delivery retry cap, and 20 (4x that) was chosen so `DISABLED_THRESHOLD` reflects genuinely sustained failure across many distinct events, not one bad delivery's own retries compounding into a false disable.
4. **`webhookSubscriptions` is a disclosed addition** beyond `IntegrationHubGraphQLModule`'s own literal "remaining §3.1 mutations/queries" list from Phase 2's doc comment.

## Out of scope for this phase (do not build yet)

- Per-provider/per-connector-type webhook event types (only `sync_job.completed` exists) - would need `SyncJobsService.complete()` (or its callers) to carry more context than a bare `SyncJob` row has today.
- Connector health dashboard, remaining observability/hardening - Phase 8.
- Wiring ADP's real mTLS handshake (ADR-0143, still open from Phase 6b).
- Encrypting the webhook secret at rest inside Vault itself beyond Vault's own storage guarantees - out of scope for every credential this module stores, not specific to this table.
