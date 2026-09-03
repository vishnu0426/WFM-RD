# ADR-0068: live dashboard API — header-trust tenant context, in-process PubSub, and the AdherenceEvent-backed degraded fallback

## Context
§4.1 asks for a GraphQL surface (queries, a mutation, subscriptions) plus
a REST snapshot fallback, "backed by the NATS event stream via a
subscription bridge, not by polling Redis on an interval." Three
sub-decisions had no existing precedent to copy:

1. **How does this new, dashboard-client-facing surface resolve tenant
   identity?** Neither of `intraday-service`'s two existing trust models
   fits: the ingestion webhook resolves tenant from a URL path segment
   verified by an HMAC signature (server-to-server, §4.2), and root's own
   `TenantContextMiddleware` does real JWT verification (ADR-0049) this
   service has no way to replicate without a materially larger build
   (a shared verification library, or a gRPC call to Module 01's
   `IdentityService`).
2. **What backs the `queueLiveStateUpdated` subscription's push
   mechanism?** `@nestjs/graphql` ships the `@Subscription()` decorator
   but no `PubSub` implementation of its own - the standard choices are
   `graphql-subscriptions` (in-process, single-instance) or
   `graphql-redis-subscriptions` (cross-instance, needs its own dedicated
   Redis connections).
3. **What does §6.1's degraded-mode fallback actually read from during a
   Redis outage?** The spec names "the most recent Postgres-persisted
   `AdherenceEvent`... as a degraded approximation" for exactly this case.

## Decision
**Tenant context**: a new, small, own-copy `TenantContextService`/
`TenantContextMiddleware` (`src/common/tenant/`), bound from a trusted
`X-Tenant-Id` header - the same **header-trust placeholder** convention
root's own middleware started with (ADR-0014) before ADR-0049 closed it,
and the same convention scheduling-service's REST API still uses today for
its own surface. Applied globally (`consumer.apply(...).forRoutes('*')`)
but never rejects a request by itself - `TenantContextService.requireTenantId()`
is what fails closed, at the point a resolver/controller actually needs a
tenant, so the ingestion webhook's own, different tenant-resolution path
is unaffected by this middleware's presence.

**PubSub**: `graphql-subscriptions`' in-process `PubSub`
(`src/graphql/pubsub.module.ts`, `@Global()`), not
`graphql-redis-subscriptions`. This service's own established scope
boundary already assumes a single running instance for its ordering/
consumer guarantees (ADR-0063's per-employee ordering, ADR-0065's dual
shift-start trigger) - a distributed pub/sub backend would be premature
infrastructure ahead of the same Phase 7 horizontal-scaling work that
boundary is already deferred to, not an independent problem to solve now.
`QueueMetricsUpdatedConsumerService` (the first real consumer of
`agno.intraday.queue.metrics_updated.v1`, provisioned since Phase 1 but
never consumed - `QueueLiveState` was dead data until this phase) writes
`QueueLiveState` and publishes the freshly-read-back record onto a
per-queue trigger (`queueLiveStateUpdatedTrigger(queueId)`,
`src/graphql/subscription-triggers.ts`); the `queueLiveStateUpdated`
subscription resolver subscribes to the identical trigger name for the
requested `queueId` - genuinely event-driven (a push happens exactly when
a real NATS message arrives), not an interval poll.

**Degraded fallback**: `AgentLiveStateQueryService` catches
`IntradayRedisUnavailableError` specifically and falls back to this
employee's most recent `AdherenceEvent` row (Phase 3's own table,
via the same `withTenantConnection` pattern the Phase 3 consumer already
uses), returning `dataFreshness: { status: 'degraded', lastKnownUpdateAt:
event.timestamp }`. The approximation is honest about what it doesn't
know: `activityStartedAt`/`adherenceStatus`/`siteId`/`queueId` come back
`null` rather than a fabricated guess, since `AdherenceEvent` doesn't
carry them. `QueueLiveStateQueryService` has no equivalent - no per-queue
Postgres history exists anywhere in this platform - so its degraded mode
is `{ ...all fields null, dataFreshness: { status: 'degraded',
lastKnownUpdateAt: null } }`, an honestly poorer fallback, not hidden.

## Consequences
- `graphql-ws` connection-level authentication is not built - the
  `queueLiveStateUpdated` subscription doesn't re-verify `X-Tenant-Id`
  against the WebSocket connection the way the query/mutation HTTP paths
  do via `TenantContextMiddleware`. A client can subscribe to any
  `queueId` it knows, without proving tenant ownership of it. Flagged
  explicitly (readiness checklist), not hidden - closing this needs
  `graphql-ws`'s `onConnect` context-building hook wired to the same
  tenant-resolution mechanism, a real but bounded follow-up.
- The header-trust tenant model is not real authentication - anyone who
  can reach this service's port can claim any tenant by setting the
  header. Explicitly the same class of gap this platform has closed once
  already (ADR-0014 → ADR-0049) and left open once (scheduling-service's
  own REST API) - not new to this platform, but now has a third instance.
- A future multi-instance deployment of `intraday-service` needs to
  revisit the PubSub choice at the same time it revisits per-employee
  consumer ordering (Phase 7) - these are coupled decisions, not
  independent ones, and should be solved together rather than the PubSub
  backend being swapped in isolation first.
