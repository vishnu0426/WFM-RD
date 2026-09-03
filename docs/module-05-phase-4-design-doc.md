# Module 05 Phase 4 Design Doc — Intraday/Real-Time Management: Live Dashboard API

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05) — Principal Performance Engineer (per §0),
this phase's own SLOs (§0.5) being the first place they're directly
exercised by real request paths rather than just write-side throughput.
**Scope:** §4.1's `agentLiveState`/`queueLiveState` GraphQL queries, the
`reportActivityChange` mutation, the `queueLiveStateUpdated` subscription,
and §4.2's REST snapshot fallback (`GET /v1/intraday/queues/:queueId/live`).
`activeAlerts`/`alertRaised`/`reallocationSuggested`/`acknowledgeAlert`/
`approveReallocation` are not built — no `Alert`/`ReallocationAction`
entity exists yet (Phase 5/6). No real JWT-based tenant authentication for
this new surface (§4's own explicit assumption, ADR-0068).

## Problem

Phases 1–3 built the entire write side of this module — nothing has ever
read `AgentLiveState`/`QueueLiveState` back out, and this service has zero
GraphQL surface at all. Three real gaps shaped this phase, not just
implementation against an existing template:

1. **GraphQL subscriptions are new territory for this entire platform.**
   Confirmed zero precedent anywhere (root's own GraphQL is queries-only).
   Verified rather than assumed that the installed `@nestjs/apollo`/
   `@nestjs/graphql` versions actually support `subscriptions: {
   'graphql-ws': {} }`, and that `graphql-ws` (not the deprecated
   `subscriptions-transport-ws`) is already available as a transitive
   dependency at the pinned version.
2. **`QueueLiveState` was dead data.** `writeQueueLiveState` (built in
   Phase 1) had exactly one caller anywhere in this repo before this
   phase — its own unit test. §4.3 names the producer for
   `queue.metrics_updated` as a "queue monitoring service" no phase of
   this module builds. Phase 4 wires the first real consumer for it,
   which is also what makes the `queueLiveStateUpdated` subscription and
   `queueLiveState` query mean anything at all.
3. **This new surface needed its own tenant-resolution model.** Neither
   existing model in this service fits a dashboard client: the ingestion
   webhook's URL-path-plus-HMAC scheme is server-to-server-specific, and
   building real JWT verification (root's ADR-0049) is materially larger
   scope than this phase takes on. See ADR-0068.

A fourth point came directly from re-reading §6.1 rather than from
research: it explicitly names "the most recent Postgres-persisted
`AdherenceEvent`... as a degraded approximation" for a Redis outage — and
this module now has exactly that data, built in Phase 3. Implementing
that literal suggestion ties this phase to Phase 3 directly.

## Decision

See ADR-0068 for the full reasoning behind the three load-bearing
decisions (header-trust tenant context, in-process PubSub, the
`AdherenceEvent`-backed degraded fallback). Summary of what shipped:

- **GraphQL**: `IntradayGraphQLModule` (`GraphQLModule.forRoot`, code-first,
  `subscriptions: { 'graphql-ws': {} }`, `formatError` mapping
  `DomainError` → `extensions.code`, copying root's `formatGraphQLError`
  shape). Types `AgentLiveState`/`QueueLiveState`/`DataFreshness`
  (`src/live-state/types.ts`, decorated with `@nestjs/graphql` but
  co-located with the domain, not the transport layer — both the GraphQL
  resolvers and the REST controller consume the exact same classes).
- **Queries**: `agentLiveState(employeeId)`/`queueLiveState(queueId)` —
  tenant from `TenantContextService.requireTenantId()`, not a GraphQL
  argument.
- **Mutation**: `reportActivityChange` — thin wrapper reusing
  `IngestionService.ingest` (Phase 1) unchanged, generating a
  `manual:<uuid>` `sourceEventId` since a dashboard-reported change has no
  ACD-provided one.
- **Subscription**: `queueLiveStateUpdated(queueId)` — reads from the
  in-process PubSub `QueueMetricsUpdatedConsumerService` publishes to.
- **`QueueMetricsUpdatedConsumerService`**: a new durable consumer
  (`DurableJetStreamConsumer`, same base every other consumer in this
  service uses) on `agno.intraday.queue.metrics_updated.v1` — writes
  `QueueLiveState`, re-reads it (so the published payload's
  `lastUpdatedAt` is what Redis actually stamped, not a client-computed
  value), publishes to the matching per-queue PubSub trigger.
- **REST snapshot**: `GET /v1/intraday/queues/:queueId/live`
  (`LiveStateRestController`) shares `QueueLiveStateQueryService` with the
  GraphQL query — one read path, two transports, matching root's own
  REST/GraphQL-share-a-service pattern.
- **`AgentLiveStateQueryService`**'s degraded fallback and
  `QueueLiveStateQueryService`'s honestly-poorer one — see ADR-0068.

## Blast radius

New `src/common/tenant/`, `src/graphql/`, `src/live-state/` directories;
one new consumer (`src/consumers/queue-metrics-updated.consumer.ts`); four
new dependencies (`@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`,
`graphql`, `graphql-subscriptions`). `IngestionModule` gains one line
(`exports: [IngestionService]`, previously provider-only) so the new
mutation resolver can reuse it. `DomainErrorFilter` gains the GraphQL
context bailout branch every other DomainErrorFilter in this platform
already has. No change to the ingestion, Phase 2 Redis-write consumers, or
Phase 3 adherence pipeline's own logic. No `docker-compose.yml` change.

## Rollback plan

Delete the three new directories and the new consumer, remove the four new
dependencies, drop `IntradayGraphQLModule`/`TenantContextModule` and the
middleware registration from `app.module.ts`, revert `IngestionModule`'s
new export line and `DomainErrorFilter`'s GraphQL branch. Nothing outside
this phase depends on any of it.

## Explicit assumptions

1. Tenant resolution is `X-Tenant-Id` header-trust, not real JWT
   verification (ADR-0068) — a real fix needs a shared verification
   library or a gRPC call to Module 01's `IdentityService`.
2. PubSub is in-process/single-instance, not `graphql-redis-subscriptions`
   (ADR-0068) — coupled to Phase 7's consumer-partitioning work, not an
   independent decision to revisit alone.
3. `activeAlerts`/`alertRaised`/`reallocationSuggested`/`acknowledgeAlert`/
   `approveReallocation` are not built — no backing entity exists yet
   (Phase 5/6).
4. `queueLiveState`'s degraded-mode fallback is honestly worse than
   `agentLiveState`'s — no per-queue Postgres history exists anywhere in
   this platform to degrade into.
5. `graphql-ws` subscription connections are not tenant-authenticated
   (ADR-0068's consequences) — a client can subscribe to any `queueId` it
   already knows without the WebSocket connection itself proving tenant
   ownership.

## Out of scope for this phase

- `Alert`/`ReallocationAction` types and everything that depends on them
  — Phase 5/6.
- Real JWT-based tenant auth for this surface, including the WebSocket
  connection itself (assumptions 1 and 5).
- Horizontal-scaling-safe, multi-instance PubSub (assumption 2), the
  100k+-agent load test proving the §0.5 SLOs hold at that scale — Phase 7.
- Multi-region — Phase 8.

## Verification

- `npm run typecheck && npm run build && npm run lint && npm test` (unit
  suite: the degraded-fallback branching with mocked Redis/Postgres,
  `reportActivityChange`'s input mapping and per-call unique
  `sourceEventId`, every resolver's tenant-context delegation, the new
  consumer's write-then-publish sequencing — no live infra needed).
- Against real Redis/NATS/Postgres: boot the service, run `agentLiveState`/
  `queueLiveState` GraphQL queries and the REST snapshot endpoint against
  real Phase 2/3-seeded data via `X-Tenant-Id`. Confirm the degraded
  fallback by exercising the Redis-unavailable code path and checking
  `dataFreshness.status === "degraded"` with an `AdherenceEvent`-sourced
  `currentActivity`. Open a `graphql-ws` WebSocket subscription to
  `queueLiveStateUpdated`, hand-publish a real message onto
  `agno.intraday.queue.metrics_updated.v1` (no real producer exists in
  this repo — verified the same way Phase 2's cross-service consumers
  were), confirm the subscription fires and `QueueLiveState` lands in
  Redis for the first time in this service's history.
