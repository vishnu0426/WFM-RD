# Module 05 Phase 4 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases
(§0.5), matching Phase 1–3's own format and honesty bar.

## Delivered in this phase (application code)

- [x] `agentLiveState(employeeId)`/`queueLiveState(queueId)` GraphQL
      queries, tenant from `TenantContextService` — proven end-to-end
      against real Redis-backed Phase 2/3 data, not just unit-tested.
- [x] `reportActivityChange` mutation, reusing `IngestionService.ingest`
      (Phase 1) unchanged — same dedupe/NATS-publish semantics as the
      webhook path, proven by unit tests including a distinct
      `sourceEventId` per call.
- [x] `queueLiveStateUpdated(queueId)` GraphQL subscription over
      `graphql-ws` — this platform's first GraphQL subscription anywhere,
      genuinely event-driven (backed by a real NATS message via
      `QueueMetricsUpdatedConsumerService`, not an interval poll) —
      verified end-to-end with a real WebSocket client and a hand-published
      NATS message, the same verification rigor Phase 2's cross-service
      consumers got.
- [x] `QueueMetricsUpdatedConsumerService`: the first real consumer of
      `agno.intraday.queue.metrics_updated.v1` (provisioned since Phase 1,
      dead until now) — `QueueLiveState` is real, populated data for the
      first time in this service's history.
- [x] `GET /v1/intraday/queues/:queueId/live` REST snapshot fallback
      (§4.2/§0.5), sharing `QueueLiveStateQueryService` with the GraphQL
      query, same `{error: {code, message, details}}` envelope this
      service already uses everywhere else.
- [x] §6.1's `dataFreshness` contract, made real on every live-state
      response (query, subscription push, and REST) — not just designed
      in a doc comment the way Phase 1's health-check groundwork left it.
- [x] `AgentLiveStateQueryService`'s Redis-outage degraded fallback to the
      most recent `AdherenceEvent` (Phase 3) — §6.1's own literal
      suggestion, implemented, not just cited. Proven against a real
      simulated Redis failure end-to-end.
- [x] Own-copy `TenantContextService`/`TenantContextMiddleware`
      (header-trust placeholder, ADR-0068) for this new surface, applied
      globally without disturbing the ingestion webhook's own,
      independent tenant-resolution path.
- [x] `DomainErrorFilter` gains the GraphQL-context bailout branch every
      other `DomainErrorFilter` in this platform already has;
      `formatGraphQLError` (own copy of root's) maps `DomainError` →
      `extensions.code`.
- [x] Unit test suite (9 new spec files: tenant context service/middleware
      including a concurrent-async-context isolation test, both
      query services' ok/degraded/rethrow branches, the REST controller,
      the new consumer, and all three resolvers) — no live infra required
      to run `npm test`.
- [x] One ADR (0068) covering the three load-bearing decisions this phase
      made without existing precedent to copy.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Real tenant authentication for this surface.** `X-Tenant-Id` is
      trusted as-is — the same class of gap this platform has closed once
      (ADR-0014 → ADR-0049) and left open once already
      (scheduling-service's own REST API), now a third instance. Anyone
      who can reach this service's port can claim any tenant.
- [ ] **`graphql-ws` connection-level tenant authentication.** The
      `queueLiveStateUpdated` subscription doesn't verify `X-Tenant-Id`
      against the WebSocket connection at all — a client can subscribe to
      any `queueId` it already knows. Needs `graphql-ws`'s `onConnect`
      hook wired to the same tenant-resolution mechanism the HTTP paths
      use — not done here (ADR-0068's consequences).
- [ ] **`activeAlerts`, `alertRaised`, `reallocationSuggested`,
      `acknowledgeAlert`, `approveReallocation`.** No `Alert`/
      `ReallocationAction` entity exists anywhere in this codebase yet —
      Phase 5/6.
- [ ] **Horizontal-scaling-safe, multi-instance PubSub.** The in-process
      `graphql-subscriptions` choice only works correctly for a single
      running instance of this service — coupled to Phase 7's
      consumer-partitioning work (ADR-0063/0065's own already-stated
      scope boundary), not an independent gap.
- [ ] **The §0.5 SLOs proven at scale** (ingestion p99 < 100ms,
      `queueLiveStateUpdated` push p99 < 500ms, REST snapshot p99 < 200ms).
      This phase's code is efficient by construction (single Redis
      `HGETALL`/`HSET` per read/write, no N+1), but no load test has run —
      Phase 7, same as every prior phase's own checklist.
- [ ] **A richer per-queue Postgres history for `QueueLiveState`'s own
      degraded fallback.** Doesn't exist anywhere in this platform — its
      degraded mode is honestly poorer than `agentLiveState`'s (design doc
      assumption 4), not silently equivalent.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases — not re-litigated per phase.
